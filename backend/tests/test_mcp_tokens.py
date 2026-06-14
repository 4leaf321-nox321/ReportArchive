"""개인 액세스 토큰(MCP) — 발급·인증·목록·취소 통합 테스트.

Run: cd backend && ./venv/bin/python -m pytest tests/test_mcp_tokens.py -v
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.users.models import PersonalAccessToken

JWT = {"Authorization": f"Bearer {create_access_token(1)}"}


def _purge(token_ids):
    db = SessionLocal()
    try:
        for tid in token_ids:
            r = db.get(PersonalAccessToken, tid)
            if r:
                db.delete(r)
        db.commit()
    finally:
        db.close()


def test_issue_authenticate_revoke():
    c = TestClient(app)
    created = []
    try:
        # 1) 발급 — 평문은 응답에 1회만
        r = c.post("/api/me/mcp-tokens", headers=JWT, json={"name": "내 노트북", "expires_days": 90})
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        plaintext = data["token"]
        tid = data["info"]["id"]
        created.append(tid)
        assert plaintext.startswith("rat_")
        assert data["info"]["token_prefix"] == plaintext[:12]
        assert data["info"]["revoked_at"] is None

        # 2) 이 rat_ 토큰으로 인증 → /api/me 가 admin 으로 해석돼야
        pat_h = {"Authorization": f"Bearer {plaintext}"}
        me = c.get("/api/me", headers=pat_h)
        assert me.status_code == 200, me.text
        assert me.json()["data"]["user"]["id"] == 1

        # 3) 목록에 보임 (평문/해시 없이)
        lst = c.get("/api/me/mcp-tokens", headers=JWT).json()["data"]
        assert any(t["id"] == tid for t in lst)
        assert "token" not in lst[0] and "token_hash" not in lst[0]

        # 4) 삭제 → 즉시 무효 + 목록에서 사라짐(하드 삭제)
        d = c.delete(f"/api/me/mcp-tokens/{tid}", headers=JWT)
        assert d.status_code == 200, d.text
        me2 = c.get("/api/me", headers=pat_h)
        assert me2.status_code == 401  # 삭제된 토큰 거부
        lst2 = c.get("/api/me/mcp-tokens", headers=JWT).json()["data"]
        assert not any(t["id"] == tid for t in lst2)  # 목록에서 제거됨
    finally:
        _purge(created)


def test_garbage_and_others_token_rejected():
    c = TestClient(app)
    # 형식만 맞고 존재하지 않는 rat_ → 401
    bad = {"Authorization": "Bearer rat_thisisnotarealtokenvalue000000000000000"}
    assert c.get("/api/me", headers=bad).status_code == 401

    created = []
    try:
        # 남의 토큰 취소 시도 → 404 (user 2 의 토큰을 user 1 이)
        r = c.post("/api/me/mcp-tokens", headers={"Authorization": f"Bearer {create_access_token(1)}"},
                   json={"name": "x"})
        tid = r.json()["data"]["info"]["id"]
        created.append(tid)
        # user 2 로 취소 시도
        d = c.delete(f"/api/me/mcp-tokens/{tid}",
                     headers={"Authorization": f"Bearer {create_access_token(2)}"})
        assert d.status_code in (404, 401)  # 2 가 없으면 401, 있으면 남의것이라 404
    finally:
        _purge(created)
