"""런타임 설정 저장소 — .env 기본값 + DB override + 검증 + 캐시 무효화."""
from __future__ import annotations

import pytest
from sqlalchemy import delete

from app.config import settings
from app.database import SessionLocal
from app.modules.app_settings import store
from app.modules.app_settings.models import AppSetting


@pytest.fixture(autouse=True)
def _clean():
    store.invalidate()
    yield
    db = SessionLocal()
    db.execute(delete(AppSetting))
    db.commit()
    db.close()
    store.invalidate()


def test_default_then_override_then_reset():
    db = SessionLocal()
    try:
        assert store.get("chunk_link_min_score") == settings.chunk_link_min_score
        store.set_many(db, {"chunk_link_min_score": 0.62}, user_id=None)
        assert store.get("chunk_link_min_score") == 0.62  # override 우선
        store.reset(db, "chunk_link_min_score")
        assert store.get("chunk_link_min_score") == settings.chunk_link_min_score
    finally:
        db.close()


def test_validation_and_unknown_key():
    db = SessionLocal()
    try:
        with pytest.raises(ValueError):
            store.set_many(db, {"chunk_link_min_score": 5.0}, None)  # > max 1.0
        with pytest.raises(ValueError):
            store.set_many(db, {"nope_unknown": 1}, None)
    finally:
        db.close()


def test_all_effective_shape():
    db = SessionLocal()
    try:
        store.set_many(db, {"chunk_link_max_per_chunk": 4}, None)
        eff = {r["key"]: r for r in store.all_effective(db)}
        row = eff["chunk_link_max_per_chunk"]
        assert row["value"] == 4 and row["overridden"] is True
        assert row["requires_reindex"] is True and row["type"] == "int"
        # 안 건드린 키는 기본값·overridden False.
        assert eff["seed_link_min_score"]["overridden"] is False
        assert eff["seed_link_min_score"]["requires_reindex"] is False
    finally:
        db.close()


def test_qa_rerank_reads_store(monkeypatch):
    from app.ai import qa

    monkeypatch.setattr(settings, "llm_backend", "openai")
    db = SessionLocal()
    try:
        store.set_many(db, {"rag_rerank_enabled": True}, None)
        assert qa._rerank_enabled() is True   # 설정 기본값(store)=True 반영
        assert qa._rerank_enabled(False) is False  # 요청 override 우선
    finally:
        db.close()
