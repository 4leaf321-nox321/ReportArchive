"""집계 라우팅 — 신호어 게이트·추출 파싱·비활성/폴백."""
from __future__ import annotations

from types import SimpleNamespace

from app.ai import structured_qa as sq
from app.config import settings
from app.database import SessionLocal


def _actor(uid=2):
    return SimpleNamespace(user=SimpleNamespace(id=uid),
                           workspace=SimpleNamespace(virtual=False, slug="dx"),
                           public_viewer=False)


def test_aggregate_cue():
    assert sq._has_aggregate_cue("낙하시험 실패한 과제 몇 개?")
    assert sq._has_aggregate_cue("보고서 목록 보여줘")
    assert not sq._has_aggregate_cue("배터리 셀 손상 원인이 뭐야")


def test_execute_exposes_full_list_for_pagination():
    """집계 목록이 답변 문장에선 30개로 잘리지만, aggregate.values 엔 전체(상한)와
    총계가 담겨 UI 가 '더 보기'로 펼칠 수 있어야(재쿼리 없이)."""
    db = SessionLocal()
    try:
        # filters 없이 전체 보고서 목록 — 값이 여럿 나오는 경로.
        r = sq._execute(db, _actor(), "보고서 목록",
                        {"filters": [], "intent": "list", "target": "report"})
        if r is None:
            return  # dev DB 에 가시 보고서 없음
        agg = r["aggregate"]
        assert "values" in agg and "values_total" in agg
        # 전체 목록은 상한까지, 총계는 count 와 일치.
        assert agg["values_total"] == agg["count"]
        assert len(agg["values"]) == min(agg["count"], sq._LIST_FULL_CAP)
        # 30개 초과면 답변 문장은 "외 N개"로 축약(문장은 안 길어짐).
        if agg["count"] > sq._MAX_LIST_PREVIEW:
            assert "외" in r["answer"] and "개" in r["answer"]
            assert len(agg["values"]) > sq._MAX_LIST_PREVIEW  # UI 는 더 받는다
    finally:
        db.close()


def test_disabled_returns_none(monkeypatch):
    # 토글 off(기본) → None(=일반 RAG).
    monkeypatch.setattr(settings, "llm_backend", "openai")
    db = SessionLocal()
    try:
        assert sq.maybe_answer(db, _actor(), "과제 몇 개?") is None
    finally:
        db.close()


def test_no_cue_skips_llm(monkeypatch):
    # 신호어 없으면 활성이어도 LLM 안 부르고 None.
    monkeypatch.setattr(sq, "_enabled", lambda: True)
    called = {"n": 0}
    monkeypatch.setattr(sq, "chat", lambda m: called.__setitem__("n", called["n"] + 1))
    db = SessionLocal()
    try:
        assert sq.maybe_answer(db, _actor(), "배터리 손상 원인 설명해줘") is None
        assert called["n"] == 0
    finally:
        db.close()


def test_extract_parse_and_non_aggregate(monkeypatch):
    monkeypatch.setattr(sq, "_enabled", lambda: True)
    # aggregate=false → None(RAG).
    monkeypatch.setattr(
        sq, "chat",
        lambda m: SimpleNamespace(backend="openai", content='{"aggregate": false}'),
    )
    db = SessionLocal()
    try:
        assert sq.maybe_answer(db, _actor(), "이거 몇 개나 되나 궁금") is None
    finally:
        db.close()


def test_grouped_sum_equals_total():
    """group-by 그룹 합 == v1 총계 (실 데이터). report_entities 없으면 스킵."""
    from sqlalchemy import func, select
    from app.ai import structured_qa as sq
    from app.database import SessionLocal
    from app.modules.entities.models import Entity, ReportEntity

    db = SessionLocal()
    try:
        row = db.execute(
            select(ReportEntity.entity_id, func.count())
            .group_by(ReportEntity.entity_id).order_by(func.count().desc()).limit(1)
        ).first()
        if not row:
            return
        ent = db.get(Entity, row[0])
        v1 = sq.aggregate(db, _actor(), [ent.value], None, "report")
        g = sq.aggregate_grouped(db, _actor(), [ent.value], None, "report", "year")
        assert g is not None and g["grouped"] is True
        assert sum(x["count"] for x in g["groups"]) == v1["count"]
    finally:
        db.close()
