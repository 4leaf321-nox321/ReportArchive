"""GraphRAG (2c, GraphRAG_설계.md) — 질문→씨앗 객체 링킹 + /ask graph 토글 배선.

공유 dev DB 라 검색 랭킹 순서에 의존하는 단언은 피하고(그 계열 테스트는 저장소
관례상 skip), 이번에 새로 만든 로직만 결정적으로 검증한다:
  1. link_query_entities — 질문에 객체 이름이 들어가면 씨앗으로, 아니면 빈 결과.
  2. POST /api/ai/ask graph 토글 — 응답에 seeds/citation 강화 필드가 실리는지.
mock 임베딩·mock LLM 기준(개발 기본).
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.ai.graph_link import link_query_entities
from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token

ADMIN = {
    "Authorization": f"Bearer {create_access_token(2)}",
    "X-Workspace-Slug": "dx",
}


def _mk_axis_and_entity(c, sfx):
    """record 축 1개 + 엔티티 1개 생성 → (type_id, entity_id, value)."""
    axis = "grtst_" + sfx
    type_id = c.post(
        "/api/entity-types", headers=ADMIN,
        json={"slug": axis, "label": "그래프검색축", "kind_class": "record"},
    ).json()["data"]["id"]
    value = "WIDGET" + sfx  # 유니크·단일 토큰 — 질문에 그대로 넣어 키워드 링킹 유도
    eid = c.post(
        "/api/entities", headers=ADMIN,
        json={"type_id": type_id, "value": value},
    ).json()["data"]["id"]
    return type_id, eid, value


def _cleanup(c, type_id, eid):
    c.delete(f"/api/entities/{eid}", headers=ADMIN)
    c.delete(f"/api/entity-types/{type_id}", headers=ADMIN)


def test_link_query_entities_keyword():
    """질문에 엔티티 값이 등장하면 씨앗으로 잡고, 없으면 빈 결과."""
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    type_id, eid, value = _mk_axis_and_entity(c, sfx)
    try:
        db = SessionLocal()
        try:
            # 값이 질문에 통째로 등장 → 씨앗(via=keyword).
            seeds = link_query_entities(db, f"{value} 낙하시험 결과 알려줘")
            ids = {s["id"] for s in seeds}
            assert eid in ids, seeds
            hit = next(s for s in seeds if s["id"] == eid)
            assert hit["via"] == "keyword" and hit["value"] == value

            # 관련 없는 질문 → 우리 엔티티는 안 잡힘.
            seeds2 = link_query_entities(db, "이번 분기 예산 계획은?")
            assert eid not in {s["id"] for s in seeds2}
        finally:
            db.close()
    finally:
        _cleanup(c, type_id, eid)


class _FakeRes:
    content = "요약입니다 [1]."
    model = "fake"
    backend = "fake"


async def _fake_cancellable(messages, *, should_cancel=None):
    return _FakeRes()


def test_ask_graph_toggle_shape(monkeypatch):
    """graph=true 응답엔 seeds + 강화 citation 필드(author/date/graph/objects)가
    실리고, graph=false 면 seeds 는 빈 리스트.

    이 dev 환경은 llm_backend 가 실제 B300(openai 호환)이라, 근거가 잡히면 LLM 을
    호출한다 — 테스트에선 호출을 async fake 로 패치해 배선만 검증(메모리 관례)."""
    from app.ai import qa

    monkeypatch.setattr(qa, "chat_cancellable", _fake_cancellable)
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    type_id, eid, value = _mk_axis_and_entity(c, sfx)
    try:
        # graph=true — 질문에 값이 있으니 씨앗으로 링킹돼야 한다.
        r = c.post(
            "/api/ai/ask", headers=ADMIN,
            json={"query": f"{value} 관련 시험 요약", "graph": True, "limit": 20},
        )
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert "seeds" in d and isinstance(d["seeds"], list)
        assert eid in {s["id"] for s in d["seeds"]}, d["seeds"]
        # citation 이 있으면 강화 필드를 갖는다(근거 유무와 무관하게 스키마 보장).
        for cite in d["citations"]:
            assert {"author", "date", "graph", "objects"} <= set(cite.keys())
            assert isinstance(cite["objects"], list)

        # graph=false — 그래프 미사용이라 seeds 비어 있음.
        r2 = c.post(
            "/api/ai/ask", headers=ADMIN,
            json={"query": f"{value} 관련 시험 요약", "graph": False},
        )
        assert r2.status_code == 200, r2.text
        assert r2.json()["data"]["seeds"] == []
    finally:
        _cleanup(c, type_id, eid)
