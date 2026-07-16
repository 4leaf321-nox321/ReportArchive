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
    """셀프 재설정 경로를 켠 상태(mock 발송 + 플래그 on)를 기본으로 둔다.
    폴백을 검사하는 테스트는 각자 필요한 쪽을 끈다."""
    prev = (settings.email_backend, settings.password_self_reset_enabled)
    settings.email_backend = "mock"
    settings.password_self_reset_enabled = True
    try:
        yield
    finally:
        settings.email_backend, settings.password_self_reset_enabled = prev


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


def test_admin_token_history_lists_lost_requests():
    """관리자 화면용 토큰 이력 — 셀프 재설정 경로로 빠져 관리자 큐에 안 뜬
    요청을 계정 단위로 집계해 보여준다. 토큰 해시는 절대 노출하지 않는다."""
    from datetime import datetime, timedelta

    from fastapi.testclient import TestClient

    from app.main import app
    from app.modules.auth.services import _hash_reset_token, create_access_token

    admin_headers = {
        "Authorization": f"Bearer {create_access_token(2)}",
        "X-Workspace-Slug": "dx",
    }
    db = SessionLocal()
    uid, email = _mk_user(db)
    try:
        u = db.get(User, uid)
        create_password_reset_token(db, u)
        create_password_reset_token(db, u)
        db.commit()

        c = TestClient(app)
        r = c.get("/api/password-reset-tokens", headers=admin_headers)
        assert r.status_code == 200, r.text
        mine = [x for x in r.json()["data"] if x["user_id"] == uid]
        assert len(mine) == 1
        row = mine[0]
        assert row["request_count"] == 2
        assert row["used_count"] == 0  # 아무도 링크를 쓰지 않음 = 유실 의심
        assert row["email"] == email
        assert row["has_pending_queue_row"] is False
        assert "token_hash" not in row and "hash" not in str(row).lower()

        # 링크를 실제로 사용하면 used_count 로 잡혀 유실과 구분된다.
        raw = create_password_reset_token(db, u)
        db.commit()
        assert consume_password_reset_token(db, raw) is not None
        db.commit()
        r2 = c.get("/api/password-reset-tokens", headers=admin_headers)
        row2 = [x for x in r2.json()["data"] if x["user_id"] == uid][0]
        assert row2["request_count"] == 3
        assert row2["used_count"] == 1

        # 기간 필터 — 조회 창 밖의 요청은 빠진다.
        for t in db.execute(
            select(PasswordResetToken).where(PasswordResetToken.user_id == uid)
        ).scalars():
            t.created_at = datetime.utcnow() - timedelta(days=200)
        db.commit()
        r3 = c.get("/api/password-reset-tokens?days=30", headers=admin_headers)
        assert not [x for x in r3.json()["data"] if x["user_id"] == uid]
        assert _hash_reset_token  # 해시 함수는 서버 내부에만 존재
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


def _assert_fell_back_to_queue(db, uid, email):
    """요청이 셀프 재설정을 타지 않고 관리자 큐로 갔는지 검사."""
    from fastapi.testclient import TestClient

    from app.main import app
    from app.modules.users.models import PasswordResetRequest, PasswordResetStatus

    c = TestClient(app)
    res = c.post("/api/auth/password-reset-requests", json={"email": email})
    assert res.status_code == 200, res.text

    row = db.execute(
        select(PasswordResetRequest).where(PasswordResetRequest.email == email)
    ).scalar_one()
    assert row.status == PasswordResetStatus.pending
    assert row.user_id == uid

    # 셀프 재설정 경로는 타지 않았는가 — 토큰도 메일 잡도 없어야 한다.
    assert (
        db.execute(
            select(PasswordResetToken).where(PasswordResetToken.user_id == uid)
        ).first()
        is None
    )
    assert not [
        j
        for j in db.execute(select(Job).where(Job.type == "send_email")).scalars()
        if email in (j.payload or {}).get("to", [])
    ]


def _cleanup_queue(db, email):
    from app.modules.users.models import PasswordResetRequest

    for r in db.execute(
        select(PasswordResetRequest).where(PasswordResetRequest.email == email)
    ).scalars():
        db.delete(r)
    db.commit()


def test_self_reset_disabled_falls_back_to_admin_queue():
    """플래그가 꺼져 있으면 메일이 나갈 수 있어도 관리자 큐로 간다.

    SMTP 를 알림·다이제스트 용도로 켜더라도 셀프 재설정이 딸려 켜지지 않아야
    한다(운영에서 셀프 재설정은 당분간 미사용).
    """
    db = SessionLocal()
    uid, email = _mk_user(db)
    settings.password_self_reset_enabled = False  # backend 는 mock(발송 가능)
    try:
        _assert_fell_back_to_queue(db, uid, email)
    finally:
        _cleanup_queue(db, email)
        _cleanup(db, uid, email)
        db.close()


def test_console_backend_falls_back_to_admin_queue():
    """console 은 로그로만 찍고 아무에게도 도달하지 않는다 → 셀프 재설정이
    켜져 있어도 관리자 중개 큐에 쌓여야 한다.

    console 을 활성으로 오인해 요청이 조용히 사라졌던 회귀의 재발 방지.
    """
    db = SessionLocal()
    uid, email = _mk_user(db)
    settings.email_backend = "console"  # 플래그는 on(autouse fixture)
    try:
        _assert_fell_back_to_queue(db, uid, email)
    finally:
        _cleanup_queue(db, email)
        _cleanup(db, uid, email)
        db.close()
