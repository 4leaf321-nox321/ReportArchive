"""온톨로지 에이전트 (tool-calling) — 루프·dispatch·인용·권한 배선.

실 B300 없이 검증: `app.ai.agent.chat` 을 스크립트형 fake 로 주입해, LLM이
search_objects 를 호출→실제 search_entities 실행→최종 답변하는 흐름을 태운다.
도구가 실서비스를 부르는지, 객체/추론과정이 누적되는지, 도구 없이 바로 답하면
no_evidence 인지 확인. mock 아님 — chat 자체를 대체하므로 결정적.
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.ai.llm import ChatResult
from app.main import app
from app.modules.auth.services import create_access_token

ADMIN = {
    "Authorization": f"Bearer {create_access_token(2)}",
    "X-Workspace-Slug": "dx",
}


def _cr(content="", tool_calls=None):
    return ChatResult(content=content, reasoning=None, model="fake", usage=None,
                      backend="fake", raw={}, tool_calls=tool_calls)


def _mk_axis_entity(c, sfx):
    axis = "agtst_" + sfx
    tid = c.post("/api/entity-types", headers=ADMIN,
                 json={"slug": axis, "label": "에이전트축", "kind_class": "record"}
                 ).json()["data"]["id"]
    value = "AGWIDGET" + sfx
    eid = c.post("/api/entities", headers=ADMIN,
                 json={"type_id": tid, "value": value}).json()["data"]["id"]
    return axis, tid, eid, value


def _cleanup(c, tid, eid):
    c.delete(f"/api/entities/{eid}", headers=ADMIN)
    c.delete(f"/api/entity-types/{tid}", headers=ADMIN)


def test_agent_calls_tool_then_answers(monkeypatch):
    """LLM이 search_objects 호출 → 실제 검색 실행 → 최종 답변. 객체·trace 누적."""
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    axis, tid, eid, value = _mk_axis_entity(c, sfx)

    # 스크립트: 1턴 search_objects 호출, 2턴 최종 답변.
    calls = {"n": 0}

    def fake_chat(messages, *, tools=None, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            return _cr(tool_calls=[{
                "id": "t1", "name": "search_objects",
                "arguments": {"type": axis, "q": value},
            }])
        return _cr(content=f"{value} 객체를 찾았습니다.")

    monkeypatch.setattr("app.ai.agent.chat", fake_chat)
    try:
        r = c.post("/api/ai/agent", headers=ADMIN, json={"query": f"{value} 알려줘"})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        # 도구가 실제로 실행돼 우리 객체를 찾았다.
        assert any(o["label"] == value for o in d["objects"]), d["objects"]
        # 추론 과정에 search_objects 가 기록되고 건수>=1.
        steps = [t for t in d["trace"] if t["tool"] == "search_objects"]
        assert steps, d["trace"]
        assert "1건" in steps[0]["summary"]  # 검색이 우리 객체 1건을 찾음
        assert d["no_evidence"] is False
        assert value in d["answer"]
    finally:
        _cleanup(c, tid, eid)


def test_agent_no_tool_direct_answer(monkeypatch):
    """도구 없이 바로 답하면 근거 없음(no_evidence) + 빈 인용/객체."""
    c = TestClient(app)

    def fake_chat(messages, *, tools=None, **kw):
        return _cr(content="특별한 근거 없이 답합니다.")

    monkeypatch.setattr("app.ai.agent.chat", fake_chat)
    r = c.post("/api/ai/agent", headers=ADMIN, json={"query": "안녕?"})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["no_evidence"] is True
    assert d["citations"] == [] and d["objects"] == []
    assert d["trace"] == []
