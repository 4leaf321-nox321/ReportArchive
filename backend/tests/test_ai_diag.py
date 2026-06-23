"""AI 연결 진단 라우트 — 시스템 관리자 게이트 + mock 백엔드 동작.

진단 탭이 부르는 엔드포인트(서버 경유). B300_보조AI_설계.md §T.

격리 원칙: 이 테스트는 **공유 dev DB 의 사용자 상태에 의존하지 않는다.** 권한 가드는
순수 단위로(require_system_admin 직접 호출), 라우트 동작은 dependency_override 로
가짜 관리자를 주입해 검증한다 — access-log·사용자 활성 등 공유 상태를 건드리지
않아 전체 스위트에서도 결정적(기존 통합테스트 격리 부채에 끼어들지 않음).

Run: cd backend && ./venv/bin/python -m pytest tests/test_ai_diag.py -v
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.ai import llm
from app.main import app
from app.modules.users.models import User
from app.shared.auth import require_system_admin


# --------------------------------------------------------------------------- #
# 권한 가드 — 순수 단위(HTTP·DB 없이)
# --------------------------------------------------------------------------- #
def test_guard_blocks_non_admin():
    with pytest.raises(HTTPException) as exc:
        require_system_admin(actor=User(is_system_admin=False))
    assert exc.value.status_code == 403


def test_guard_allows_admin():
    admin = User(is_system_admin=True)
    assert require_system_admin(actor=admin) is admin


# --------------------------------------------------------------------------- #
# 엔드포인트가 가드로 보호되는지 — 토큰 없으면 401(사용자 조회 전 차단, DB 무관)
# --------------------------------------------------------------------------- #
def test_endpoints_require_auth():
    c = TestClient(app)
    assert c.get("/api/ai/diag/config").status_code == 401
    assert c.post("/api/ai/diag/ping").status_code == 401
    assert c.post("/api/ai/diag/chat", json={"prompt": "hi"}).status_code == 401


# --------------------------------------------------------------------------- #
# 라우트 동작 — 가짜 관리자 주입 + mock 백엔드(공유 상태 무관)
# --------------------------------------------------------------------------- #
@pytest.fixture
def admin_client(monkeypatch):
    monkeypatch.setattr(llm.settings, "llm_backend", "mock")
    monkeypatch.setattr(llm.settings, "llm_model", "GLM-5-2")
    app.dependency_overrides[require_system_admin] = lambda: User(
        id=999, is_system_admin=True
    )
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(require_system_admin, None)


def test_config_returns_resolved_settings(admin_client):
    r = admin_client.get("/api/ai/diag/config")
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["backend"] == "mock"
    assert data["model"] == "GLM-5-2"
    assert data["has_api_key"] is False


def test_ping_ok_on_mock(admin_client):
    r = admin_client.post("/api/ai/diag/ping")
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["ok"] is True
    assert data["model_returned"] == "GLM-5-2"
    assert "latency_ms" in data
    assert data["has_reasoning"] is False


def test_chat_echoes_on_mock(admin_client):
    r = admin_client.post("/api/ai/diag/chat", json={"prompt": "엔진 응력 요약"})
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert "엔진 응력 요약" in data["content"]
    assert data["backend"] == "mock"
    assert data["reasoning"] is None


def test_chat_rejects_empty_prompt(admin_client):
    r = admin_client.post("/api/ai/diag/chat", json={"prompt": ""})
    assert r.status_code == 422  # pydantic min_length
