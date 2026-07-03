"""알림 → 이메일 팬아웃(옵트인) — 수신자 설정에 따라 send_email 잡 적재 여부.

email_backend 와 무관하게 enqueue 단계만 검증한다(잡이 쌓이는지). 세션은
커밋하지 않고 롤백해 DB를 오염시키지 않는다.
"""
from __future__ import annotations

from sqlalchemy import select

from app.database import SessionLocal
from app.jobs.models import Job
from app.modules.notifications.models import NotificationType
from app.modules.notifications.services import create_notification
from app.modules.users.models import User


def _mk_user(db, email, prefs):
    u = User(email=email, name="테스트", preferences=prefs, is_active=True)
    db.add(u)
    db.flush()
    return u


def _email_jobs_for(db, email):
    rows = db.execute(select(Job).where(Job.type == "send_email")).scalars().all()
    return [j for j in rows if email in (j.payload or {}).get("to", [])]


def test_opt_in_all_enqueues_email():
    db = SessionLocal()
    try:
        u = _mk_user(db, "optall@samsung.com", {"email_notifications": "all"})
        create_notification(
            db, recipient_user_id=u.id, type=NotificationType.comment_new
        )
        jobs = _email_jobs_for(db, "optall@samsung.com")
        assert len(jobs) == 1, jobs
    finally:
        db.rollback()
        db.close()


def test_off_default_no_email():
    db = SessionLocal()
    try:
        u = _mk_user(db, "optoff@samsung.com", {})  # 기본 off
        create_notification(
            db, recipient_user_id=u.id, type=NotificationType.comment_new
        )
        assert _email_jobs_for(db, "optoff@samsung.com") == []
    finally:
        db.rollback()
        db.close()


def test_important_level_filters_by_type():
    db = SessionLocal()
    try:
        u = _mk_user(db, "optimp@samsung.com", {"email_notifications": "important"})
        # 비중요 종류 → 이메일 없음
        create_notification(
            db, recipient_user_id=u.id, type=NotificationType.comment_new
        )
        assert _email_jobs_for(db, "optimp@samsung.com") == []
        # 중요 종류(멘션) → 이메일 적재
        create_notification(
            db, recipient_user_id=u.id, type=NotificationType.comment_mention
        )
        assert len(_email_jobs_for(db, "optimp@samsung.com")) == 1
    finally:
        db.rollback()
        db.close()


def test_non_email_identifier_skipped():
    db = SessionLocal()
    try:
        u = _mk_user(db, "adminlike", {"email_notifications": "all"})  # @ 없음
        create_notification(
            db, recipient_user_id=u.id, type=NotificationType.comment_mention
        )
        assert _email_jobs_for(db, "adminlike") == []
    finally:
        db.rollback()
        db.close()
