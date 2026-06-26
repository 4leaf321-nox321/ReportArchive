"""아카이브 RAG Q&A (A, §A) — 게이트 + 응답 구조.

기능 권한(§E) 게이트(미권한 403), 답변 구조(answer/citations/no_evidence),
엔티틀먼트 부여 후 접근. mock LLM 백엔드라 답변 내용은 검증 안 함(흐름만).
"""
from __future__ import annotations

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


def test_ask_requires_entitlement_and_structure():
    c = TestClient(app)

    # 미권한(user3, grant 없음) → 403.
    r = c.post("/api/ai/ask", headers=USER3, json={"query": "낙하 시험 요약"})
    assert r.status_code == 403, r.text

    # 권한자(admin bypass) → 200 + 응답 구조.
    r = c.post(
        "/api/ai/ask", headers=ADMIN, json={"query": "낙하 시험에서 취약한 부품"}
    )
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert {"answer", "citations", "no_evidence"} <= set(d.keys())
    assert isinstance(d["citations"], list)
    for cite in d["citations"]:
        assert {"n", "report_id", "title"} <= set(cite.keys())

    # user3 에게 rag_qa 부여 → 200(게이트 통과). 정리.
    g = c.post(
        "/api/ai/entitlements",
        headers=ADMIN,
        json={"feature": "rag_qa", "subject_kind": "user", "user_id": 3},
    )
    eid = g.json()["data"]["id"]
    try:
        r2 = c.post("/api/ai/ask", headers=USER3, json={"query": "시험 결과"})
        assert r2.status_code == 200, r2.text
        assert "no_evidence" in r2.json()["data"]
    finally:
        c.delete(f"/api/ai/entitlements/{eid}", headers=ADMIN)

    # 회수 후 다시 403.
    r3 = c.post("/api/ai/ask", headers=USER3, json={"query": "시험"})
    assert r3.status_code == 403
