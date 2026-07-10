"""질문 분해(_decompose) + 별칭 확장(_alias_expand) — 로드맵 2 잔여."""
from __future__ import annotations

from types import SimpleNamespace

from app.ai import qa


def test_parse_json_list():
    assert qa._parse_json_list('설명 ["a", "b", 1, "c"]') == ["a", "b", "c"]
    assert qa._parse_json_list("json 아님") == []


def test_decompose_and_fallback(monkeypatch):
    # 정상 분해.
    monkeypatch.setattr(
        qa, "chat",
        lambda m: SimpleNamespace(backend="openai", content='["방수 통과 과제", "낙하 실패 과제"]'),
    )
    assert qa._decompose("방수 통과하고 낙하 실패한 과제") == ["방수 통과 과제", "낙하 실패 과제"]
    # 상한(_MAX_SUBQUESTIONS).
    monkeypatch.setattr(
        qa, "chat",
        lambda m: SimpleNamespace(backend="openai", content='["a","b","c","d","e"]'),
    )
    assert qa._decompose("q") == ["a", "b", "c"]
    # mock/오류/빈 → [원질문].
    monkeypatch.setattr(qa, "chat", lambda m: SimpleNamespace(backend="mock", content="[]"))
    assert qa._decompose("원질문") == ["원질문"]
    monkeypatch.setattr(qa, "chat", lambda m: SimpleNamespace(backend="openai", content="[]"))
    assert qa._decompose("원질문") == ["원질문"]

    def _boom(m):
        raise RuntimeError("down")
    monkeypatch.setattr(qa, "chat", _boom)
    assert qa._decompose("원질문") == ["원질문"]


def test_alias_expand_no_match_returns_none():
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        # 온톨로지에 없을 무의미 토큰 → 확장 없음(None).
        assert qa._alias_expand(db, "zzqqxx9988 무관토큰") is None
    finally:
        db.close()
