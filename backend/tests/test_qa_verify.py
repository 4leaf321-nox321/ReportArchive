"""근거 검증(_verify) — 파싱·미달 카운트·mock/오류 폴백·override."""
from __future__ import annotations

from types import SimpleNamespace

from app.ai import qa
from app.config import settings


def test_verify_parse_and_unsupported(monkeypatch):
    payload = ('{"claims":[{"text":"A","supported":true,"source":2,"quote":"근거"},'
               '{"text":"B","supported":false,"source":null,"quote":""}]}')
    monkeypatch.setattr(qa, "chat", lambda m: SimpleNamespace(backend="openai", content=payload))
    v = qa._verify("답변", ["[1] ...", "[2] 근거"])
    assert v["unsupported"] == 1 and len(v["claims"]) == 2
    assert v["claims"][0]["supported"] and v["claims"][0]["source"] == 2
    assert not v["claims"][1]["supported"]


def test_verify_fallback(monkeypatch):
    monkeypatch.setattr(qa, "chat", lambda m: SimpleNamespace(backend="mock", content="{}"))
    assert qa._verify("답변", ["[1] x"]) is None
    monkeypatch.setattr(qa, "chat", lambda m: SimpleNamespace(backend="openai", content="json아님"))
    assert qa._verify("답변", ["[1] x"]) is None
    assert qa._verify("", ["[1] x"]) is None
    assert qa._verify("답변", []) is None


def test_verify_enabled_precedence(monkeypatch):
    monkeypatch.setattr(settings, "llm_backend", "openai")
    from app.database import SessionLocal
    from app.modules.app_settings import store
    db = SessionLocal()
    try:
        store.set_many(db, {"rag_verify_enabled": False}, None)
        assert qa._verify_enabled() is False
        assert qa._verify_enabled(True) is True
        store.reset(db, "rag_verify_enabled")
    finally:
        db.close()
    monkeypatch.setattr(settings, "llm_backend", "mock")
    assert qa._verify_enabled(True) is False
