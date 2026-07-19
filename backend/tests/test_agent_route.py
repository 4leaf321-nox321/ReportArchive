"""복합질문 에이전트 자동 라우팅 — 휴리스틱 게이트·비활성/폴백·응답 정규화.

test_structured_qa.py 와 같은 패턴(LLM 없이 라우터 로직만 검증)."""
from __future__ import annotations

from types import SimpleNamespace

from app.ai import agent_route as ar
from app.config import settings
from app.database import SessionLocal


def _actor(uid=2):
    return SimpleNamespace(user=SimpleNamespace(id=uid),
                           workspace=SimpleNamespace(virtual=False, slug="dx"),
                           public_viewer=False)


def test_multihop_cue():
    # 다홉/관계 신호어가 있으면 복합, 단순 서술 질문은 아님.
    assert ar._has_multihop_cue("A공급사 부품이 물린 과제는?")
    assert ar._has_multihop_cue("낙하시험을 담당한 팀의 결론은?")
    assert not ar._has_multihop_cue("배터리 손상 원인 설명해줘")
    assert not ar._has_multihop_cue("가장 취약한 부품이 뭐야")


def test_disabled_returns_none(monkeypatch):
    # 플래그 off → None(=일반 RAG). 신호어가 있어도.
    #
    # ⚠️ 플래그는 .env 가 아니라 **DB**(app_settings)에서 온다. "기본값이 off 겠지"
    # 하고 주변 상태에 기대면, DB 에 override 가 남아 있을 때 **없는 LLM 을 호출해
    # 타임아웃까지 매달린다**(dev 서버엔 LLM 이 없다). 여기서 명시적으로 끈다.
    monkeypatch.setattr(ar, "_enabled", lambda: False)
    monkeypatch.setattr(settings, "llm_backend", "openai")
    db = SessionLocal()
    try:
        assert ar.maybe_route_agent(db, _actor(), "A공급사 부품이 물린 과제는?") is None
    finally:
        db.close()


def test_no_cue_skips_agent(monkeypatch):
    # 활성이어도 신호어 없으면 run_agent 를 절대 안 부르고 None(단순질문 과금 방지).
    monkeypatch.setattr(ar, "_enabled", lambda: True)
    called = {"n": 0}

    from app.ai import agent
    monkeypatch.setattr(
        agent, "run_agent",
        lambda *a, **k: called.__setitem__("n", called["n"] + 1) or {},
    )
    db = SessionLocal()
    try:
        assert ar.maybe_route_agent(db, _actor(), "배터리 손상 원인 설명해줘") is None
        assert called["n"] == 0
    finally:
        db.close()


def test_normalizes_agent_result(monkeypatch):
    # 복합으로 판정되면 run_agent 결과에 seeds 를 채워 /ask 형태로 정규화.
    monkeypatch.setattr(ar, "_enabled", lambda: True)
    monkeypatch.setattr(ar, "_is_complex", lambda db, q: True)

    from app.ai import agent
    fixture = {"answer": "A", "citations": [], "objects": [{"type": "part", "id": "1"}],
               "trace": [{"hop": 1, "tool": "search_objects"}], "no_evidence": False}
    monkeypatch.setattr(agent, "run_agent", lambda *a, **k: dict(fixture))

    db = SessionLocal()
    try:
        res = ar.maybe_route_agent(db, _actor(), "아무 복합 질문")
    finally:
        db.close()
    assert res is not None
    assert res["seeds"] == []               # 정규화: 프론트 askResult.seeds 보호
    assert res["objects"] == fixture["objects"]  # 에이전트 고유 필드 보존
    assert res["trace"] == fixture["trace"]
