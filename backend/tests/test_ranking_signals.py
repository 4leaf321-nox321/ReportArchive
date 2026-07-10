"""랭킹 신호 — 부스트 배수·_blend 적용·기본0 무효과."""
from __future__ import annotations

from app.ai import qa


def test_boost_value():
    assert qa._boost_value(1.0, 0.0, 0.0, 0.0) == 1.0        # 가중 0 → 무효과
    assert qa._boost_value(1.0, 0.0, 0.5, 0.0) == 1.5        # 최신성만
    assert qa._boost_value(0.5, 0.5, 1.0, 0.4) == 1.0 + 0.5 + 0.2


def test_blend_applies_boosts():
    plain = [
        {"report_id": 1, "rrf_score": 1.0},
        {"report_id": 2, "rrf_score": 0.9},
    ]
    # boost 없으면 1이 앞.
    assert [h["report_id"] for h in qa._blend(plain, [], 5)] == [1, 2]
    # 2를 크게 부스트하면 순위 역전.
    out = qa._blend(plain, [], 5, boosts={1: 1.0, 2: 1.5})
    assert [h["report_id"] for h in out] == [2, 1]


def test_ranking_boosts_zero_weight_noop(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "rag_recency_weight", 0.0)
    monkeypatch.setattr(settings, "rag_authority_weight", 0.0)
    from app.database import SessionLocal
    db = SessionLocal()
    try:
        assert qa._ranking_boosts(db, [1, 2, 3]) == {}   # 무효과 빠른 경로
    finally:
        db.close()
