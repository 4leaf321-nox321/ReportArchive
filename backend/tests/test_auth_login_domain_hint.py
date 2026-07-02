"""로그인 도메인 힌트 — 시스템 관리자만 "@" 없는 아이디로 로그인하고,
일반 사용자가 도메인 없이 아이디만 넣으면 samsung.com 을 붙이라고 안내한다.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

_HINT = "samsung.com 도메인을 함께 입력해주세요."


def test_non_admin_without_at_gets_domain_hint():
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"email": "hong.gildong", "password": "x"})
    assert r.status_code == 401, r.text
    assert r.json()["message"] == _HINT, r.json()


def test_with_at_falls_through_to_normal_error():
    c = TestClient(app)
    r = c.post(
        "/api/auth/login",
        json={"email": "nobody@samsung.com", "password": "x"},
    )
    assert r.status_code == 401, r.text
    assert r.json()["message"] != _HINT, r.json()


def test_admin_id_without_at_is_not_hinted():
    """admin(시스템 관리자)은 "@" 없이도 힌트 대신 일반 인증 경로를 탄다."""
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"email": "admin", "password": "wrong-pw"})
    assert r.status_code == 401, r.text
    # 비번이 틀렸으므로 일반 실패 메시지여야 하고, 도메인 힌트가 아니어야 한다.
    assert r.json()["message"] != _HINT, r.json()
