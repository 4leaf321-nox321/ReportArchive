"""셀프 비밀번호 재설정(이메일 링크) — 요청→토큰→확인, 1회용·만료·오류.

email_backend=mock 으로 강제해 실제 발송 없이 큐 잡에서 토큰을 추출한다.
세션 정리를 위해 생성한 유저/토큰/잡을 삭제한다.
"""
from __future__ import annotations

import re
import uuid

import pytest
from sqlalchemy import select

from app.config import settings
from app.database import SessionLocal
from app.jobs.models import Job
from app.modules.auth.services import (
    consume_password_reset_token,
    create_password_reset_token,
    hash_password,
    verify_password,
)
from app.modules.users.models import PasswordResetToken, User


@pytest.fixture(autouse=True)
def _mock_backend():
    prev = settings.email_backend
    settings.email_backend = "mock"
    try:
        yield
    finally:
        settings.email_backend = prev


def _mk_user(db):
    email = f"pwr_{uuid.uuid4().hex[:8]}@samsung.com"
    u = User(
        email=email,
        name="재설정테스트",
        password_hash=hash_password("oldpass123"),
        is_active=True,
    )
    db.add(u)
    db.commit()
    return u.id, email


def _cleanup(db, uid, email):
    for t in db.execute(
        select(PasswordResetToken).where(PasswordResetToken.user_id == uid)
    ).scalars():
        db.delete(t)
    for j in db.execute(select(Job).where(Job.type == "send_email")).scalars():
        if email in (j.payload or {}).get("to", []):
            db.delete(j)
    u = db.get(User, uid)
    if u:
        db.delete(u)
    db.commit()


def test_request_sends_reset_link_and_confirm_changes_password():
    from fastapi.testclient import TestClient

    from app.main import app

    c = TestClient(app)
    db = SessionLocal()
    uid, email = _mk_user(db)
    try:
        r = c.post("/api/auth/password-reset-requests", json={"email": email})
        assert r.status_code in (200, 202), r.text

        jobs = [
            j
            for j in db.execute(select(Job).where(Job.type == "send_email")).scalars()
            if email in (j.payload or {}).get("to", [])
        ]
        assert jobs, "재설정 이메일 잡이 없습니다"
        body = (jobs[-1].payload.get("text") or "") + (jobs[-1].payload.get("html") or "")
        token = re.search(r"token=([\w\-]+)", body).group(1)

        # 잘못된 토큰 → 400
        r = c.post(
            "/api/auth/password-reset/confirm",
            json={"token": "bogus", "new_password": "newpass123"},
        )
        assert r.status_code == 400

        # 올바른 토큰 → 변경
        r = c.post(
            "/api/auth/password-reset/confirm",
            json={"token": token, "new_password": "newpass123"},
        )
        assert r.status_code == 200, r.text

        # 재사용 → 400
        r = c.post(
            "/api/auth/password-reset/confirm",
            json={"token": token, "new_password": "another123"},
        )
        assert r.status_code == 400

        db.expire_all()
        u = db.get(User, uid)
        assert verify_password("newpass123", u.password_hash)
        assert u.must_change_password is False
    finally:
        _cleanup(db, uid, email)
        db.close()


def test_expired_token_rejected():
    from datetime import datetime, timedelta

    db = SessionLocal()
    uid, email = _mk_user(db)
    try:
        u = db.get(User, uid)
        raw = create_password_reset_token(db, u)
        # 만료 처리
        row = db.execute(
            select(PasswordResetToken).where(PasswordResetToken.user_id == uid)
        ).scalar_one()
        row.expires_at = datetime.utcnow() - timedelta(minutes=1)
        db.commit()
        assert consume_password_reset_token(db, raw) is None
    finally:
        _cleanup(db, uid, email)
        db.close()
