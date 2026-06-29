"""큐 연산 — enqueue / claim / 완료·실패 전이 / reaper.

claim 은 `SELECT … FOR UPDATE SKIP LOCKED` 로 다중 워커/스레드가 같은 행을
중복 처리하지 않도록 보장한다(원자적). 시각 비교는 전부 서버 `now()` 로
통일해 TZ 불일치를 피한다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import delete, func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.jobs.models import (
    STATUS_CANCELED,
    STATUS_DONE,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_RUNNING,
    Job,
    WorkerHeartbeat,
)


# 재시도 지수 백오프(초). attempts(1부터) 인덱스로 사용, 넘으면 마지막 값.
_BACKOFF_S = [5, 30, 120, 600, 3600]


def backoff_seconds(attempts: int) -> int:
    """attempts 회차에 대한 다음 재시도 지연(초)."""
    if attempts <= 0:
        return _BACKOFF_S[0]
    return _BACKOFF_S[min(attempts, len(_BACKOFF_S)) - 1]


def enqueue(
    session: Session,
    type: str,
    payload: Optional[dict] = None,
    *,
    dedup_key: Optional[str] = None,
    priority: int = 0,
    delay_seconds: int = 0,
    max_attempts: int = 5,
    created_by: Optional[int] = None,
) -> int:
    """주문서 한 줄 적재. 호출한 요청의 트랜잭션에 함께 묶인다(flush 만).

    커밋은 호출자 책임 — 보통 라우트의 get_db 의존성이 요청 끝에서 커밋/롤백.
    이렇게 해야 "보고서 저장 + 작업 적재"가 원자적으로 함께 반영/롤백된다.

    dedup_key 가 이미 (type, dedup_key) 로 pending/running 상태에 있으면
    UniqueViolation 이 난다 — 호출자가 의도적으로 무시하려면 try/except.
    """
    run_after = None
    if delay_seconds > 0:
        run_after = datetime.now(timezone.utc) + timedelta(seconds=delay_seconds)

    job = Job(
        type=type,
        payload=payload or {},
        dedup_key=dedup_key,
        priority=priority,
        max_attempts=max_attempts,
        created_by=created_by,
    )
    if run_after is not None:
        job.run_after = run_after
    session.add(job)
    session.flush()  # job.id 확보 (커밋은 호출자)
    return job.id


# claim: 대기 작업 1건을 원자적으로 running 으로 전이하고 id 반환.
# attempts 를 여기서 +1 — 처리 중 워커가 죽어 reaper 가 회수해도 무한
# 재시도되지 않게(회수도 1회 시도로 카운트).
_CLAIM_SQL = text(
    """
    UPDATE jobs
       SET status='running',
           locked_at=now(),
           worker_id=:wid,
           attempts=attempts+1,
           updated_at=now()
     WHERE id = (
         SELECT id FROM jobs
          WHERE status='pending' AND run_after <= now()
          ORDER BY priority DESC, run_after, id
            FOR UPDATE SKIP LOCKED
          LIMIT 1
     )
    RETURNING id
    """
)


def claim(session: Session, worker_id: str) -> Optional[Job]:
    """대기 작업 1건을 집어 running 으로. 없으면 None.

    집은 즉시 커밋 — running 상태를 영속화해 다른 워커/사후 조회에 반영.
    이후 처리는 새 트랜잭션에서.
    """
    row = session.execute(_CLAIM_SQL, {"wid": worker_id}).first()
    if row is None:
        session.rollback()
        return None
    session.commit()
    return session.get(Job, row.id)


def mark_done(session: Session, job: Job, result: Optional[dict] = None) -> None:
    job.status = "done"
    job.result = result
    job.last_error = None
    job.locked_at = None
    session.commit()


def mark_failed(session: Session, job: Job, error: str) -> None:
    """실패 처리. attempts < max 면 백오프 후 pending 으로 되돌려 재시도,
    소진했으면 failed 로 종결."""
    job.last_error = error[:4000]
    job.locked_at = None
    if job.attempts < job.max_attempts:
        job.status = STATUS_PENDING
        job.run_after = datetime.now(timezone.utc) + timedelta(
            seconds=backoff_seconds(job.attempts)
        )
    else:
        job.status = STATUS_FAILED
    session.commit()


# reaper: 워커가 죽어 'running' 으로 갇힌 행 회수.
# attempts 가 이미 max 면 곧장 failed, 아니면 pending 으로(즉시 재시도 가능).
_REAP_SQL = text(
    """
    UPDATE jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
           locked_at = NULL,
           worker_id = NULL,
           last_error = COALESCE(last_error, '') ,
           updated_at = now()
     WHERE status='running'
       AND locked_at < now() - make_interval(secs => :timeout)
    RETURNING id
    """
)


def reap_stuck(session: Session, timeout_seconds: int) -> int:
    """좀비 회수. 회수된 작업 수 반환."""
    rows = session.execute(_REAP_SQL, {"timeout": timeout_seconds}).fetchall()
    session.commit()
    return len(rows)


# --- 운영 가시성(관리자) 연산 --------------------------------------------------
# 아래는 "작업 큐" 관리자 탭이 쓰는 조회/조치. 처리 핫패스(claim/mark_*)와 분리.

def stats(session: Session, *, recent_failed_hours: int = 24) -> dict:
    """큐 한눈 요약 — 상태별·종류별 카운트, 가장 오래된 대기 경과(초),
    처리 중 수, 최근 N시간 실패 수. 관리자 탭 상단 카드용."""
    by_status = dict(
        session.execute(
            select(Job.status, func.count()).group_by(Job.status)
        ).all()
    )
    by_type = dict(
        session.execute(
            select(Job.type, func.count())
            .group_by(Job.type)
            .order_by(func.count().desc())
        ).all()
    )
    # 가장 오래 기다린 pending 의 경과(초) — 적체 신호.
    oldest_pending = session.execute(
        select(func.min(Job.run_after)).where(Job.status == STATUS_PENDING)
    ).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    oldest_pending_age_s = (
        int((now - oldest_pending).total_seconds())
        if oldest_pending is not None
        else None
    )
    since = now - timedelta(hours=recent_failed_hours)
    recent_failed = session.execute(
        select(func.count())
        .where(Job.status == STATUS_FAILED)
        .where(Job.updated_at >= since)
    ).scalar_one()
    return {
        "by_status": {k: int(v) for k, v in by_status.items()},
        "by_type": {k: int(v) for k, v in by_type.items()},
        "pending": int(by_status.get(STATUS_PENDING, 0)),
        "running": int(by_status.get(STATUS_RUNNING, 0)),
        "failed": int(by_status.get(STATUS_FAILED, 0)),
        "done": int(by_status.get(STATUS_DONE, 0)),
        "canceled": int(by_status.get(STATUS_CANCELED, 0)),
        "oldest_pending_age_s": oldest_pending_age_s,
        "recent_failed": int(recent_failed),
        "recent_failed_hours": recent_failed_hours,
    }


def list_jobs(
    session: Session,
    *,
    status: Optional[str] = None,
    type: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[Job], int]:
    """필터(상태·종류)된 전체 잡 목록 + 총건수. 최신(updated_at) 순."""
    conds = []
    if status:
        conds.append(Job.status == status)
    if type:
        conds.append(Job.type == type)
    total = session.execute(
        select(func.count()).select_from(Job).where(*conds)
    ).scalar_one()
    rows = session.scalars(
        select(Job)
        .where(*conds)
        .order_by(Job.updated_at.desc(), Job.id.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    return list(rows), int(total)


def requeue(session: Session, job: Job) -> bool:
    """failed/canceled 잡을 즉시 재시도 대상(pending)으로 되돌린다. attempts 를
    0 으로 리셋해 백오프·종결 카운트를 새로 시작. running/pending 은 건드리지
    않음(False). 커밋은 호출자."""
    if job.status not in (STATUS_FAILED, STATUS_CANCELED):
        return False
    job.status = STATUS_PENDING
    job.attempts = 0
    job.run_after = datetime.now(timezone.utc)
    job.locked_at = None
    job.worker_id = None
    job.last_error = None
    return True


def requeue_filtered(
    session: Session, *, status: str = STATUS_FAILED, type: Optional[str] = None
) -> int:
    """필터에 맞는 잡을 일괄 재시도(pending, attempts=0, run_after=now). 되돌린
    건수 반환. 기본은 failed 전체 — LLM 복구 후 죽은 요약을 한 번에 살릴 때."""
    if status not in (STATUS_FAILED, STATUS_CANCELED):
        raise ValueError("재시도는 failed/canceled 상태만 가능합니다.")
    conds = [Job.status == status]
    if type:
        conds.append(Job.type == type)
    now = datetime.now(timezone.utc)
    result = session.execute(
        Job.__table__.update()
        .where(*conds)
        .values(
            status=STATUS_PENDING,
            attempts=0,
            run_after=now,
            locked_at=None,
            worker_id=None,
            last_error=None,
            updated_at=now,
        )
    )
    session.commit()
    return int(result.rowcount or 0)


def cancel(session: Session, job: Job) -> bool:
    """대기(pending) 잡을 취소(canceled) — 워커가 더는 집지 않는다. 이미
    running/done/failed/canceled 면 변경 없음(False). 커밋은 호출자."""
    if job.status != STATUS_PENDING:
        return False
    job.status = STATUS_CANCELED
    job.locked_at = None
    job.worker_id = None
    return True


def purge(
    session: Session, *, status: str, older_than_days: int = 7
) -> int:
    """오래된 종결 잡(done/canceled/failed) 청소 — 테이블 위생. 삭제 건수 반환.
    안전을 위해 종결 상태만 허용(pending/running 삭제 금지)."""
    if status not in (STATUS_DONE, STATUS_CANCELED, STATUS_FAILED):
        raise ValueError("정리는 done/canceled/failed 상태만 가능합니다.")
    cutoff = datetime.now(timezone.utc) - timedelta(days=older_than_days)
    result = session.execute(
        delete(Job).where(Job.status == status).where(Job.updated_at < cutoff)
    )
    session.commit()
    return int(result.rowcount or 0)


# --- 워커 하트비트 ------------------------------------------------------------
def touch_heartbeat(
    session: Session, worker_id: str, *, meta: Optional[dict] = None
) -> None:
    """워커 생존 신호 upsert — 메인 루프가 주기적으로 호출. last_seen 갱신.
    실패해도 처리에 영향 없도록 호출자가 예외를 흡수한다."""
    now = datetime.now(timezone.utc)
    stmt = pg_insert(WorkerHeartbeat).values(
        worker_id=worker_id, started_at=now, last_seen=now, meta=meta or {}
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[WorkerHeartbeat.worker_id],
        set_={"last_seen": now, "meta": meta or {}},
    )
    session.execute(stmt)
    session.commit()


def recent_workers(session: Session, *, within_seconds: int = 30) -> list[dict]:
    """최근 within_seconds 안에 신호를 보낸 워커 목록. 하나라도 있으면 '살아있음'."""
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=within_seconds)
    rows = session.scalars(
        select(WorkerHeartbeat)
        .where(WorkerHeartbeat.last_seen >= cutoff)
        .order_by(WorkerHeartbeat.last_seen.desc())
    ).all()
    return [
        {
            "worker_id": w.worker_id,
            "started_at": w.started_at.isoformat(),
            "last_seen": w.last_seen.isoformat(),
            "meta": w.meta or {},
        }
        for w in rows
    ]
