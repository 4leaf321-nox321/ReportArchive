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


def test_llm_dependent_settings_are_marked():
    """LLM 을 부르는 설정에 requires_llm 표식이 있어야 관리자 화면이 경고할 수 있다.

    표식이 없으면 관리자가 LLM 끊긴 서버에서 무심코 켜고, 그 기능을 쓰는 질문이
    LLM 타임아웃(120초, 에이전트는 최대 6홉)까지 매달리다 502 로 실패한다.
    코드의 가드는 `llm_backend != mock` 만 보므로 "설정은 됐는데 서버가 죽은"
    경우를 못 거른다 — 그래서 화면 경고가 필요하다.

    ⚠️ 새 설정을 추가할 때 이 목록도 갱신할 것. 코드에서 자동 판별할 방법이 없어
    (가드가 각 모듈에 흩어져 있다) 명시 목록으로 고정한다.
    """
    expected = {
        "rag_rerank_enabled",
        "rag_hyde_enabled",
        "rag_decompose_enabled",
        "rag_aggregate_routing_enabled",
        "rag_auto_route_enabled",
        "rag_verify_enabled",
    }
    marked = {k for k, v in store.REGISTRY.items() if v.get("requires_llm")}
    assert marked == expected, (
        f"표식 누락: {expected - marked} / 잘못 표식: {marked - expected}"
    )
    # 별칭 확장은 별칭 테이블 조회라 LLM 불필요 — 표식이 붙으면 안 된다.
    assert not store.REGISTRY["rag_alias_expand_enabled"].get("requires_llm")


def test_all_effective_exposes_requires_llm():
    """관리자 API 응답에 실려 나가야 화면이 배지를 그린다."""
    db = SessionLocal()
    try:
        rows = store.all_effective(db)
    finally:
        db.close()
    by_key = {r["key"]: r for r in rows}
    assert by_key["rag_auto_route_enabled"]["requires_llm"] is True
    assert by_key["chunk_link_min_score"]["requires_llm"] is False
