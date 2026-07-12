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
from app.modules.alerts.models import AlertRule
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


def next_alert_run(kind: str, interval_minutes, now) -> datetime:
    """다음 실행 시각. interval=상대 간격, weekly=다음 주 월요일 00:00,
    monthly=다음 달 1일 00:00(주초·달 초 앵커). now 는 tz-aware UTC."""
    if kind == "weekly":
        days_ahead = (7 - now.weekday()) % 7 or 7  # 항상 미래의 월요일
        return (now + timedelta(days=days_ahead)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
    if kind == "monthly":
        if now.month == 12:
            return now.replace(year=now.year + 1, month=1, day=1,
                               hour=0, minute=0, second=0, microsecond=0)
        return now.replace(month=now.month + 1, day=1,
                           hour=0, minute=0, second=0, microsecond=0)
    return now + timedelta(minutes=interval_minutes or 1440)


def run_alerts_scheduler_tick(session: Session) -> dict:
    """due 한 경보 규칙을 run_alert_rule 잡으로 적재하고 next_run_at 을 민다
    (Phase D 2단계). 커넥터 tick 과 동형 — dedup_key 로 이전 실행이 아직 대기/실행
    중이면 이번 주기는 건너뛴다. 실제 평가는 워커(handlers/run_alert_rule)가 처리.
    schedule_kind: interval(간격)·weekly(주초)·monthly(달 초)."""
    due = list(
        session.scalars(
            select(AlertRule).where(
                AlertRule.enabled.is_(True),
                AlertRule.schedule_kind != "manual",
                AlertRule.next_run_at.is_not(None),
                AlertRule.next_run_at <= func.now(),
            )
        ).all()
    )

    enqueued = 0
    skipped = 0
    for rule in due:
        next_run = next_alert_run(
            rule.schedule_kind, rule.interval_minutes, datetime.now(timezone.utc)
        )
        rule_id = rule.id
        try:
            enqueue(
                session,
                "run_alert_rule",
                {"rule_id": rule_id},
                dedup_key=f"alert-rule-{rule_id}",
                max_attempts=1,
            )
            rule.next_run_at = next_run
            session.commit()
            enqueued += 1
        except IntegrityError:
            session.rollback()
            again = session.get(AlertRule, rule_id)
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
