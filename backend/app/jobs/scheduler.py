"""주기 스케줄러 — due 한 데이터소스 동기화를 작업 큐에 적재.

systemd 타이머(reportarchive-scheduler.timer)가 매분 scripts/scheduler_tick.py 를 실행하고,
이 함수가 next_run_at 이 지난 interval 소스를 찾아 sync_data_source 잡으로 enqueue 한다.
실제 동기화는 워커가 처리(handlers/sync_data_source.py) — 스케줄러는 '적재'만.

dedup_key=`sync-source-{id}` 로 **이전 동기화 잡이 아직 대기/실행 중이면 중복 적재하지
않는다**(워커가 느리거나 소스가 오래 걸려도 잡이 쌓이지 않음). 잡이 끝나면 다음 주기에
다시 적재된다.

이 tick 은 범용 스케줄 인프라의 첫 소비자다 — Phase D(경보·다이제스트)도 나중에 같은
타이머에 태울 수 있다(설계 §5.2).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.jobs.queue import enqueue
from app.modules.connectors.models import DataSource


def run_scheduler_tick(session: Session) -> dict:
    """due 한 interval 소스를 sync 잡으로 적재하고 next_run_at 을 민다.
    반환: {due, enqueued, skipped, at}."""
    due = list(
        session.scalars(
            select(DataSource).where(
                DataSource.enabled.is_(True),
                DataSource.schedule_kind == "interval",
                DataSource.next_run_at.is_not(None),
                DataSource.next_run_at <= func.now(),
            )
        ).all()
    )

    enqueued = 0
    skipped = 0
    for src in due:
        interval = src.interval_minutes or 60
        next_run = datetime.now(timezone.utc) + timedelta(minutes=interval)
        source_id = src.id
        created_by = src.created_by_user_id
        try:
            enqueue(
                session,
                "sync_data_source",
                {"source_id": source_id},
                dedup_key=f"sync-source-{source_id}",
                max_attempts=3,
                created_by=created_by,
            )
            src.next_run_at = next_run
            session.commit()
            enqueued += 1
        except IntegrityError:
            # 이전 동기화 잡이 아직 대기/실행 중 — 이번 주기는 건너뛰되 next_run 은 민다.
            session.rollback()
            again = session.get(DataSource, source_id)
            if again is not None:
                again.next_run_at = next_run
                session.commit()
            skipped += 1

    return {
        "due": len(due),
        "enqueued": enqueued,
        "skipped": skipped,
        "at": datetime.now(timezone.utc).isoformat(),
    }
