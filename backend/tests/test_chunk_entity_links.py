"""청크↔객체 링크 (p74) — 탐지 + 검색(가시성 게이팅).

- entity_ids_in_text: 결정적 경계매칭(값·코드·별칭).
- chunks_for_entities: 씨앗 객체를 직접 언급하는 청크를 벡터-무관하게 가져오되,
  요청자가 볼 수 있는 보고서만(가시성 게이트).
"""
from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy import delete, select

from app.ai import search as ai_search
from app.ai.models import ReportChunk
from app.config import settings
from app.database import SessionLocal
from app.modules.entities.autotag import entity_ids_in_text
from app.modules.reports import services as rep_services
from app.modules.reports.models import Report

_SENTINEL = 987654321  # 실제 엔티티와 안 겹치는 청크 태그용 id


def _actor(uid=2):
    return SimpleNamespace(
        user=SimpleNamespace(id=uid),
        workspace=SimpleNamespace(virtual=False, slug="dx"),
        public_viewer=False,
    )


def test_entity_ids_in_text():
    idx = [(10, ["배터리", "sm-s931"]), (20, ["카메라"])]
    assert set(entity_ids_in_text("차세대 배터리 개발 · SM-S931 검증", idx)) == {10}
    assert entity_ids_in_text("SM-S9310", [(10, ["sm-s931"])]) == []  # 경계 차단
    assert entity_ids_in_text("무관 텍스트", idx) == []


def test_chunks_for_entities_and_visibility_gate(monkeypatch):
    db = SessionLocal()
    made_chunk = False
    try:
        # user 2 가 볼 수 있는 보고서 하나(소프트삭제 아님).
        visible = rep_services.all_visible_report_ids(db, 2)
        rid = next((r for r in visible
                    if db.get(Report, r) and db.get(Report, r).deleted_at is None), None)
        if rid is None:
            return  # 보고서 없으면 스킵
        # 그 보고서에 _SENTINEL 객체를 언급하는 청크 삽입.
        db.add(ReportChunk(
            report_id=rid, chunk_index=99999, text="테스트 청크 — 센티넬 객체 언급.",
            embedding=[0.0] * settings.embedding_dim,
            entity_ids=[_SENTINEL],
        ))
        db.commit()
        made_chunk = True

        # 씨앗=센티넬 → 그 구절을 벡터-무관하게 가져온다.
        res = ai_search.chunks_for_entities(db, [_SENTINEL], _actor(2))
        assert any(r["report_id"] == rid for r in res), res

        # ★ 가시성 게이트 — 볼 수 있는 게 없으면 빈 결과.
        monkeypatch.setattr(
            "app.ai.search.all_visible_report_ids", lambda db, uid: set()
        )
        assert ai_search.chunks_for_entities(db, [_SENTINEL], _actor(2)) == []
    finally:
        if made_chunk:
            db.execute(delete(ReportChunk).where(
                ReportChunk.entity_ids.op("&&")([_SENTINEL])
            ))
            db.commit()
        db.close()
