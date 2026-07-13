"""대화형 에이전트 검색 — 맥락 질의 재작성(_contextualize) + run_agent(history=).

재작성은 fake chat 주입으로 결정적 검증(실 LLM 불필요).
"""
from app.ai import agent, qa


class _Res:
    def __init__(self, content, backend="openai"):
        self.content = content
        self.backend = backend
        self.tool_calls = None
        self.model = "m"


def test_contextualize_skips_without_history():
    # 첫 턴(히스토리 없음) → 원 질문 그대로, LLM 호출 안 함.
    assert qa._contextualize(None, "낙하시험 실패 몇 개?") == "낙하시험 실패 몇 개?"
    assert qa._contextualize([], "x") == "x"


def test_contextualize_rewrites_followup(monkeypatch):
    monkeypatch.setattr(qa, "chat", lambda msgs: _Res("2024년 낙하시험 실패 과제"))
    hist = [
        {"role": "user", "content": "낙하시험 실패 몇 개?"},
        {"role": "assistant", "content": "3건입니다."},
    ]
    assert qa._contextualize(hist, "그 중 2024년만?") == "2024년 낙하시험 실패 과제"


def test_contextualize_falls_back_on_mock(monkeypatch):
    monkeypatch.setattr(qa, "chat", lambda msgs: _Res("무언가", backend="mock"))
    hist = [{"role": "user", "content": "낙하시험 실패 몇 개?"}]
    # mock 백엔드 → 폴백(원 질문).
    assert qa._contextualize(hist, "그 중 2024년만?") == "그 중 2024년만?"


def test_run_agent_uses_rewritten_query(monkeypatch):
    monkeypatch.setattr(qa, "_contextualize", lambda h, q: "재작성된질문")
    captured = {}

    def fake_chat(messages, tools=None, tool_choice=None):
        captured["messages"] = messages
        return _Res("답변")  # tool_calls=None → 첫 홉에서 답변 종료

    monkeypatch.setattr(agent, "chat", fake_chat)
    r = agent.run_agent(
        db=None, actor=None, query="그 중 2024년만?",
        history=[{"role": "user", "content": "x"}],
    )
    # 재작성된 질문이 에이전트 user 메시지로 들어갔는지.
    assert any(m.get("content") == "재작성된질문" for m in captured["messages"])
    # 재해석 노출.
    assert r.get("rewritten_query") == "재작성된질문"


def test_run_agent_injects_history(monkeypatch):
    # 이전 턴을 에이전트 message 로 통째 주입(system 과 현재 질문 사이).
    monkeypatch.setattr(qa, "_contextualize", lambda h, q: "STANDALONE")
    captured = {}

    def fake_chat(messages, tools=None, tool_choice=None):
        captured["messages"] = messages
        return _Res("답변")

    monkeypatch.setattr(agent, "chat", fake_chat)
    agent.run_agent(
        db=None, actor=None, query="후속",
        history=[
            {"role": "user", "content": "이전질문"},
            {"role": "assistant", "content": "이전답변"},
        ],
    )
    msgs = captured["messages"]
    contents = [m.get("content") for m in msgs]
    assert "이전질문" in contents and "이전답변" in contents  # 히스토리 주입됨
    assert msgs[0]["role"] == "system"
    assert msgs[-1]["content"] == "STANDALONE"  # 현재(재작성) 질문이 마지막


def test_run_agent_no_history_no_rewrite(monkeypatch):
    # 히스토리 없으면 재작성 없음 → rewritten_query 미포함.
    def fake_chat(messages, tools=None, tool_choice=None):
        return _Res("답변")

    monkeypatch.setattr(agent, "chat", fake_chat)
    r = agent.run_agent(db=None, actor=None, query="낙하시험 실패 몇 개?")
    assert "rewritten_query" not in r
