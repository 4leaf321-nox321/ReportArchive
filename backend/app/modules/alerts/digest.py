"""경보 이메일 다이제스트 (Phase D 3b).

매 실행마다 메일을 보내는 대신, **직전 발송 이후 새로 걸린 발화를 모아 하루 1통**의
요약 메일을 시스템 관리자에게 보낸다. 스케줄러 tick 이 매분 호출하지만 self-gate
(마지막 발송 후 20시간 미만이면 skip)로 하루 1회로 눌린다.

즉시 개별 이메일은 email_fanout 에서 alert_firing 을 억제 → 이 다이제스트가 유일한
이메일 채널(인앱 알림 3a 는 그대로). 백엔드가 console 이면 로그만, smtp 면 실발송.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.modules.alerts.models import AlertDigestRun, AlertRule, AlertRuleState

# tick 은 매분 도니 self-gate 로 하루 1회. 20h(24h 미만)로 두어 스케줄 지터를 흡수.
DIGEST_MIN_GAP_HOURS = 20


def _last_sent(db: Session):
    return db.execute(select(func.max(AlertDigestRun.sent_at))).scalar()


def _new_firings_since(db: Session, since: datetime) -> list[dict]:
    """since 이후 새로 발화(firing 진입)한 대상을 규칙별로 집계."""
    rows = db.execute(
        select(AlertRule.id, AlertRule.name, func.count())
        .join(AlertRuleState, AlertRuleState.rule_id == AlertRule.id)
        .where(
            AlertRuleState.state == "firing",
            AlertRuleState.first_fired_at > since,
        )
        .group_by(AlertRule.id, AlertRule.name)
        .order_by(func.count().desc())
    ).all()
    return [{"rule_id": r[0], "name": r[1], "count": int(r[2])} for r in rows]


def _admin_recipients(db: Session) -> list[tuple]:
    """이메일 켠 시스템 관리자 (User, email). email off/이메일아닌아이디 제외."""
    from app.modules.users.models import User

    out = []
    users = db.execute(
        select(User).where(User.is_system_admin.is_(True), User.is_active.is_(True))
    ).scalars()
    for u in users:
        email = (u.email or "").strip()
        if "@" not in email:
            continue
        if (u.preferences or {}).get("email_notifications", "off") == "off":
            continue
        out.append((u, email))
    return out


def build_and_send_digest(db: Session, *, force: bool = False) -> dict:
    """다이제스트 1회 시도. 반환 {sent, ...}. force=True 면 self-gate 무시(수동/테스트)."""
    now = datetime.utcnow()
    last = _last_sent(db)
    if not force and last is not None and (now - last) < timedelta(hours=DIGEST_MIN_GAP_HOURS):
        return {"sent": 0, "skipped": "too_soon"}

    since = last if last is not None else (now - timedelta(hours=24))
    groups = _new_firings_since(db, since)
    if not groups:
        # 새 발화 없으면 빈 메일 안 보냄. 워터마크도 안 밈(다음 주기에 모아서).
        return {"sent": 0, "skipped": "nothing_new"}

    recipients = _admin_recipients(db)
    if not recipients:
        # 구독자 0 → 발송·기록 안 함(워터마크 안 밈). 나중에 옵트인하면 그때부터 모음.
        return {"sent": 0, "skipped": "no_recipients"}

    total = sum(g["count"] for g in groups)
    lines = " · ".join(f"{g['name']} {g['count']}건" for g in groups)
    subject = f"[{settings.app_name}] 경보 요약 — 새 발화 {total}건"
    message = f"최근 새로 걸린 경보: {lines}"
    url = f"{settings.email_base_url}/admin/alerts"

    from app.mailer import service as mail_service

    for _u, email in recipients:
        mail_service.enqueue_email(
            db,
            to=email,
            template="notification",
            context={
                "title": "경보 요약",
                "message": message,
                "url": url,
                "action_label": "경보 열기",
                "subject": subject,
            },
        )

    db.add(AlertDigestRun(
        sent_at=now, recipients=len(recipients),
        summary={"groups": groups, "total": total},
    ))
    db.commit()
    return {"sent": len(recipients), "total": total, "groups": len(groups)}
