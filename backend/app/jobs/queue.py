"""큐 연산 — enqueue / claim / 완료·실패 전이 / reaper.

claim 은 `SELECT … FOR UPDATE SKIP LOCKED` 로 다중 워커/스레드가 같은 행을
중복 처리하지 않도록 보장한다(원자적). 시각 비교는 전부 서버 `now()` 로
통일해 TZ 불일치를 피한다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.jobs.models import (
    STATUS_FAILED,
    STATUS_PENDING,
    Job,
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
