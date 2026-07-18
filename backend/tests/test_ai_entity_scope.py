"""객체 스코프 AI (A') — 객체 프로필의 Q&A/요약 엔드포인트.

기능 권한(rag_qa) 게이트, 없는 객체 404, 응답 구조. mock LLM 이라 내용은 검증 안 함.
가시성은 hybrid_search 가 이미 보장(별도 유출 테스트는 test_ai_ask 계열이 커버).
스코프 대상 엔티티는 테스트가 만들고 정리한다(임의 축 하나 재사용).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token

ADMIN = {
    "Authorization": f"Bearer {create_access_token(2)}",
    "X-Workspace-Slug": "personal-1",
}
USER3 = {
    "Authorization": f"Bearer {create_access_token(3)}",
    "X-Workspace-Slug": "dx",
}


@pytest.fixture()
def entity_id():
    """임의 축에 테스트 객체 1건 생성 → id 반환 → 정리."""
    c = TestClient(app)
    types = c.get("/api/entity-types", headers=ADMIN).json()["data"]["items"]
    if not types:
        pytest.skip("엔티티 축(타입)이 시드에 없음 — 스킵")
    type_id = types[0]["id"]
    r = c.post(
        "/api/entities",
        headers=ADMIN,
        json={"type_id": type_id, "value": "스코프AI테스트객체"},
    )
    assert r.status_code == 201, r.text
    eid = r.json()["data"]["id"]
    yield eid
    c.delete(f"/api/entities/{eid}", headers=ADMIN)


def test_entity_ask_gate_and_structure(entity_id):
    c = TestClient(app)

    # 미권한(user3) → 403.
    r = c.post(
        f"/api/ai/entities/{entity_id}/ask", headers=USER3,
        json={"query": "이 객체 이슈"},
    )
    assert r.status_code == 403, r.text

    # 권한자(admin bypass) → 200 + Q&A 응답 구조(/ask 와 동일).
    r = c.post(
        f"/api/ai/entities/{entity_id}/ask", headers=ADMIN,
        json={"query": "이 객체와 관련된 이슈는?"},
    )
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert {"answer", "citations", "no_evidence"} <= set(d.keys())
    assert isinstance(d["citations"], list)

    # 없는 객체 → 404.
    r = c.post(
        "/api/ai/entities/999999999/ask", headers=ADMIN,
        json={"query": "x"},
    )
    assert r.status_code == 404, r.text


def test_entity_summary_gate_and_structure(entity_id):
    c = TestClient(app)

    # 미권한 → 403.
    r = c.post(f"/api/ai/entities/{entity_id}/summary", headers=USER3)
    assert r.status_code == 403, r.text

    # 권한자 → 200 + 요약 구조. 방금 만든 객체는 태깅 보고서가 없어 no_evidence=True.
    r = c.post(f"/api/ai/entities/{entity_id}/summary", headers=ADMIN)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert "summary" in d
    assert d.get("no_evidence") is True
    assert d.get("report_count") == 0

    # 없는 객체 → 404.
    r = c.post("/api/ai/entities/999999999/summary", headers=ADMIN)
    assert r.status_code == 404, r.text
