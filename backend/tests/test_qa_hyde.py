"""HyDE — 가상 답변 문단으로 시맨틱 임베딩 대체(키워드·씨앗은 원 질문 유지)."""
from __future__ import annotations

from types import SimpleNamespace

from app.ai import qa
from app.ai import search as ai_search
from app.config import settings
from app.database import SessionLocal


def _actor(uid=2):
    return SimpleNamespace(
        user=SimpleNamespace(id=uid),
        workspace=SimpleNamespace(virtual=False, slug="dx"),
        public_viewer=False,
    )


def test_hyde_builds_anchored_text(monkeypatch):
    # 원 질문 + 가상 문단을 함께(앵커) 반환.
    monkeypatch.setattr(
        qa, "chat", lambda m: SimpleNamespace(backend="openai", content="가상 답변 문단."),
    )
    out = qa._hyde("셀 용량?")
    assert out == "셀 용량?\n가상 답변 문단.", out


def test_hyde_fallback_none(monkeypatch):
    # mock 백엔드 → None(원 질문 폴백).
    monkeypatch.setattr(qa, "chat", lambda m: SimpleNamespace(backend="mock", content="x"))
    assert qa._hyde("q") is None
    # LLM 예외 → None.
    def _boom(m):
        raise RuntimeError("down")
    monkeypatch.setattr(qa, "chat", _boom)
    assert qa._hyde("q") is None
    # 빈 응답 → None.
    monkeypatch.setattr(qa, "chat", lambda m: SimpleNamespace(backend="openai", content="  "))
    assert qa._hyde("q") is None


def test_embed_query_used_for_vector_not_keyword(monkeypatch):
    # semantic_search 는 embed_query 를 임베딩하고, 키워드는 원 query 를 쓴다.
    seen = {}
    monkeypatch.setattr(
        ai_search, "embed_one",
        lambda t: (seen.setdefault("vec", t), [0.0] * settings.embedding_dim)[1],
    )
    db = SessionLocal()
    try:
        ai_search.semantic_search(db, "원질문", _actor(), embed_query="HYDE문단", limit=1)
    finally:
        db.close()
    assert seen.get("vec") == "HYDE문단", seen
