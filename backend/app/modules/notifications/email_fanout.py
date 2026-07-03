"""알림 → 이메일 팬아웃(옵트인).

인앱 알림이 생성될 때, 수신자가 이메일 수신을 켜뒀고 해당 종류가 대상이면
send_email 잡을 적재한다. 사용자 환경설정 `preferences.email_notifications`:
  - "off"       (기본) — 이메일 안 보냄
  - "important" — 중요한 종류만(IMPORTANT_TYPES)
  - "all"       — 모든 종류

메일 본문의 딥링크는 프론트 NotificationsPage.deepLinkFor 와 동일한 규칙으로
만든다(같은 위치로 도착).
"""
from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.config import settings
from app.modules.notifications.models import Notification, NotificationType

logger = logging.getLogger("app.mailer")

# type → (제목/라벨, 본문 문장). 본문의 {actor} 는 행위자 이름으로 치환.
_LABELS: dict[NotificationType, tuple[str, str]] = {
    NotificationType.comment_new: ("새 코멘트", "{actor}님이 보고서에 코멘트를 남겼습니다."),
    NotificationType.comment_reply: ("코멘트 답글", "{actor}님이 회원님의 코멘트에 답글을 남겼습니다."),
    NotificationType.comment_mention: ("멘션", "{actor}님이 코멘트에서 회원님을 언급했습니다."),
    NotificationType.comment_resolved: ("코멘트 해결", "{actor}님이 코멘트 스레드를 해결 처리했습니다."),
    NotificationType.mount_new_to_me: ("보고서 게시", "{actor}님이 회원님의 보고서를 게시판에 게시했습니다."),
    NotificationType.mount_new_in_board: ("게시판 새 보고서", "게시판에 새 보고서가 올라왔습니다."),
    NotificationType.composite_included: ("종합보고 포함", "회원님의 보고서가 종합보고에 포함되었습니다."),
    NotificationType.composite_cited_upward: ("상위 종합 인용", "회원님의 보고서가 상위 종합보고에 인용되었습니다."),
    NotificationType.composite_published: ("종합보고 발행", "회원님이 작성한 종합보고가 발행되었습니다."),
    NotificationType.report_locked: ("보고서 잠금", "{actor}님이 보고서를 편집 잠금했습니다."),
    NotificationType.report_lock_force_unset: ("잠금 해제", "{actor}님이 보고서 잠금을 강제 해제했습니다."),
    NotificationType.report_edited_by_other: ("보고서 수정됨", "{actor}님이 보고서를 수정했습니다."),
    NotificationType.editor_added: ("편집자 추가", "{actor}님이 회원님을 보고서 편집자로 추가했습니다."),
    NotificationType.report_ongoing_reminder: ("진행중 보고서 리마인더", "진행중 보고서를 업데이트할 시간입니다."),
    NotificationType.report_phase_to_reviewing: ("검토 단계 전환", "보고서가 검토(게시) 단계로 전환되었습니다."),
    NotificationType.report_phase_to_finalized: ("완료 처리", "보고서가 완료 처리되었습니다."),
}

# "important" 레벨에서 이메일을 보낼 종류 — 개인이 직접 챙겨야 하는 것들.
IMPORTANT_TYPES: frozenset[NotificationType] = frozenset(
    {
        NotificationType.comment_mention,
        NotificationType.comment_reply,
        NotificationType.mount_new_to_me,
        NotificationType.editor_added,
        NotificationType.composite_included,
        NotificationType.composite_cited_upward,
        NotificationType.report_edited_by_other,
    }
)


def _deep_link(n: Notification) -> str | None:
    """프론트 deepLinkFor 와 동일 규칙의 상대경로 + 기준 URL."""
    base = settings.email_base_url
    if not base:
        return None
    path = None
    if n.ref_table in ("reports", "comment_threads"):
        report_id = n.ref_id if n.ref_table == "reports" else (n.payload or {}).get("report_id")
        if report_id:
            ws = n.workspace_slug or "personal"
            path = f"/w/{ws}/reports/{report_id}"
            if n.ref_table == "comment_threads" and n.ref_id:
                path += f"#thread={n.ref_id}"
    elif n.ref_table == "composite_reports" and n.ref_id and n.workspace_slug:
        path = f"/w/{n.workspace_slug}/composites/{n.ref_id}"
    return f"{base}{path}" if path else None


def maybe_enqueue_email(db: Session, notification: Notification) -> None:
    """수신자 설정을 보고 필요하면 이메일 잡을 적재한다. 실패해도 알림 생성은
    영향받지 않게 조용히 삼킨다(이메일은 부가 채널)."""
    try:
        from app.modules.users.models import User

        recipient = db.get(User, notification.recipient_user_id)
        if recipient is None or not recipient.is_active:
            return
        email = (recipient.email or "").strip()
        if "@" not in email:  # admin("admin") 등 이메일 아닌 아이디는 제외
            return
        level = (recipient.preferences or {}).get("email_notifications", "off")
        if level == "off":
            return
        ntype = notification.type
        if level == "important" and ntype not in IMPORTANT_TYPES:
            return

        title, msg_tmpl = _LABELS.get(ntype, (settings.app_name + " 알림", "새 알림이 있습니다."))
        actor_name = ""
        if notification.actor_user_id:
            from app.modules.users.models import User as _U

            actor = db.get(_U, notification.actor_user_id)
            actor_name = (actor.name if actor else "") or "누군가"
        message = msg_tmpl.format(actor=actor_name or "누군가")
        url = _deep_link(notification)

        from app.mailer import service as mail_service

        mail_service.enqueue_email(
            db,
            to=email,
            template="notification",
            context={
                "title": title,
                "message": message,
                "url": url,
                "action_label": "열기",
            },
            dedup_key=f"notif:{notification.id}",
        )
    except Exception:  # noqa: BLE001 — 이메일 실패가 알림/본작업을 막지 않게
        logger.warning("알림 이메일 팬아웃 실패(무시)", exc_info=True)
