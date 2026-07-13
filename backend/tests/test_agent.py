"""온톨로지 에이전트 (tool-calling) — 루프·dispatch·인용·권한 배선.

실 B300 없이 검증: `app.ai.agent.chat` 을 스크립트형 fake 로 주입해, LLM이
search_objects 를 호출→실제 search_entities 실행→최종 답변하는 흐름을 태운다.
도구가 실서비스를 부르는지, 객체/추론과정이 누적되는지, 도구 없이 바로 답하면
no_evidence 인지 확인. mock 아님 — chat 자체를 대체하므로 결정적.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

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


def test_verify_blocks_skips_snippetless_citations():
    """근거 텍스트가 있는 인용만 [번호] 블록으로. 인용 n 을 그대로 보존."""
    from app.ai import agent

    blocks = agent._verify_blocks([
        {"n": 1, "report_id": 7, "title": "제동시험", "snippet": "제동 거리 40m."},
        {"n": 2, "report_id": 9, "title": "집계결과"},  # 스니펫 없음(집계 인용) → 제외
    ])
    assert len(blocks) == 1
    assert blocks[0].startswith("[1] (보고서: 제동시험)")
    assert "제동 거리 40m." in blocks[0]


def test_agent_attaches_verification(monkeypatch):
    """검증 on 이면 에이전트 답변에도 verification 이 붙는다(질문하기 레이어 재사용)."""
    from app.ai import agent, agent_tools, qa

    calls = {"n": 0}

    def fake_chat(messages, *, tools=None, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            return _cr(tool_calls=[{
                "id": "t1", "name": "search_reports",
                "arguments": {"query": "제동 성능"},
            }])
        return _cr(content="제동 거리는 40m 입니다.[1]")

    # search_reports 도구가 근거 스니펫을 반환하도록 대체(실 검색·DB 불필요).
    def fake_run_tool(db, actor, name, args):
        return {"content": {"count": 1}, "objects": [],
                "reports": [{"report_id": 7, "title": "제동시험",
                             "snippet": "제동 거리는 40m 로 측정되었다."}]}

    monkeypatch.setattr(agent, "chat", fake_chat)
    monkeypatch.setattr(agent_tools, "run_tool", fake_run_tool)
    # 검증 on + 검증 LLM 응답 고정(qa 레이어 재사용).
    monkeypatch.setattr(qa, "_verify_enabled", lambda override=None: True)
    monkeypatch.setattr(qa, "chat", lambda m: SimpleNamespace(
        backend="openai",
        content=('{"claims":[{"text":"제동 거리 40m","supported":true,'
                 '"source":1,"quote":"제동 거리는 40m 로 측정되었다."}]}')))

    d = agent.run_agent(None, None, "제동 성능?")
    v = d["verification"]
    assert v["unsupported"] == 0
    assert v["claims"][0]["supported"] and v["claims"][0]["source"] == 1


def test_agent_no_verification_when_disabled(monkeypatch):
    """검증 off 면 verification 키가 없다(기본 동작 불변)."""
    from app.ai import agent, agent_tools, qa

    def fake_chat(messages, *, tools=None, **kw):
        return _cr(content="근거 없이 답합니다.")

    monkeypatch.setattr(agent, "chat", fake_chat)
    monkeypatch.setattr(qa, "_verify_enabled", lambda override=None: False)
    d = agent.run_agent(None, None, "안녕?")
    assert "verification" not in d
