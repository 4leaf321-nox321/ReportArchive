"""엔티티 머지 보조 (p60, 엔티티머지보조_설계.md) — 탐지·기각·감사 로그.

임베딩은 mock 으로 고정해 L0(정규화) 결정적 동작을 검증한다(ollama 의존 X).
mock 백엔드면 find_merge_candidates 는 L0 그룹핑만 수행한다.
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.entities import merge_candidates as mc
from app.modules.entities import services
from app.modules.entities.models import (
    Entity,
    EntityMerge,
    EntityMergeDismissal,
    EntityStatus,
    EntityType,
)

ADMIN = 2
USER = 3


def _h(uid):
    return {"Authorization": f"Bearer {create_access_token(uid)}"}


def _mk_axis_with(values):
    """임시 축 + 값들 생성 → (type_id, [entity_id...]). 호출자가 _cleanup 으로 정리."""
    db = SessionLocal()
    try:
        t = EntityType(
            slug="zzmerge_" + uuid.uuid4().hex[:6],
            label="머지테스트",
            entry_policy="open",
        )
        db.add(t)
        db.flush()
        ids = []
        for v in values:
            e = Entity(type_id=t.id, value=v, status=EntityStatus.active)
            db.add(e)
            db.flush()
            ids.append(e.id)
        db.commit()
        return t.id, ids
    finally:
        db.close()


def _cleanup(type_id):
    db = SessionLocal()
    try:
        db.query(EntityMergeDismissal).filter(
            EntityMergeDismissal.type_id == type_id
        ).delete()
        db.query(EntityMerge).filter(EntityMerge.type_id == type_id).delete()
        for e in db.query(Entity).filter(Entity.type_id == type_id).all():
            db.delete(e)
        t = db.get(EntityType, type_id)
        if t:
            db.delete(t)
        db.commit()
    finally:
        db.close()


def test_l0_normalization_clusters(monkeypatch):
    """정규화(casefold+공백/하이픈 제거)로 같은 키가 되는 값들이 한 클러스터로.
    'Galaxy S26'·'galaxy-s26'·'GALAXYS26' → 'galaxys26' 동일. '아이폰17'은 분리."""
    monkeypatch.setattr("app.config.settings.embedding_backend", "mock")
    type_id, ids = _mk_axis_with(
        ["Galaxy S26", "galaxy-s26", "GALAXYS26", "아이폰17"]
    )
    try:
        db = SessionLocal()
        try:
            res = mc.find_merge_candidates(db, type_id)
        finally:
            db.close()
        assert res["backend"] == "mock"
        # 정확히 한 클러스터(갤럭시 3종), 아이폰은 단독이라 클러스터 아님.
        assert len(res["clusters"]) == 1, res["clusters"]
        cl = res["clusters"][0]
        assert cl["exact"] is True
        members = {m["value"] for m in cl["members"]}
        assert members == {"Galaxy S26", "galaxy-s26", "GALAXYS26"}
        assert "아이폰17" not in members
    finally:
        _cleanup(type_id)


def test_dismiss_excludes_pair(monkeypatch):
    """기각한 쌍은 다음 스캔에서 클러스터를 못 만든다(두 값짜리 클러스터 기준)."""
    monkeypatch.setattr("app.config.settings.embedding_backend", "mock")
    type_id, ids = _mk_axis_with(["Galaxy S26", "GALAXYS26"])
    try:
        db = SessionLocal()
        try:
            assert len(mc.find_merge_candidates(db, type_id)["clusters"]) == 1
            a, b = db.get(Entity, ids[0]), db.get(Entity, ids[1])
            assert services.dismiss_merge_pair(db, entity_a=a, entity_b=b, user_id=None)
            # 멱등 — 두 번째는 False.
            assert not services.dismiss_merge_pair(
                db, entity_a=a, entity_b=b, user_id=None
            )
            res2 = mc.find_merge_candidates(db, type_id)
            assert len(res2["clusters"]) == 0, "기각 쌍이 다시 떴음"
        finally:
            db.close()
    finally:
        _cleanup(type_id)


def test_scan_endpoint_admin_only(monkeypatch):
    """스캔 엔드포인트는 admin 전용(비admin 403), admin 은 클러스터 반환."""
    monkeypatch.setattr("app.config.settings.embedding_backend", "mock")
    type_id, ids = _mk_axis_with(["Galaxy S26", "GALAXYS26", "X1"])
    try:
        c = TestClient(app)
        r403 = c.post(
            f"/api/entity-types/{type_id}/merge-candidates", headers=_h(USER)
        )
        assert r403.status_code == 403, r403.text
        r = c.post(
            f"/api/entity-types/{type_id}/merge-candidates", headers=_h(ADMIN)
        )
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        assert len(data["clusters"]) == 1
    finally:
        _cleanup(type_id)


def test_validate_cluster_llm(monkeypatch):
    """LLM 검증자 — chat 패치로 duplicates/outliers 를 값→id 로 매핑하는지.
    mock 백엔드면 verdict 없이 backend='mock'."""
    import types

    type_id, ids = _mk_axis_with(["갤럭시S26", "GALAXYS26", "S26 Ultra"])
    try:
        from app.modules.entities import merge_candidates as mcmod

        # mock 백엔드 — verdict 없음.
        monkeypatch.setattr("app.config.settings.llm_backend", "mock")
        db = SessionLocal()
        try:
            v0 = mcmod.validate_cluster(db, type_id, ids)
            assert v0["backend"] == "mock"
            assert v0["duplicate_ids"] is None
        finally:
            db.close()

        # openai 백엔드 + chat 패치 — 갤럭시S26/GALAXYS26=중복, Ultra=outlier.
        monkeypatch.setattr("app.config.settings.llm_backend", "openai")

        def fake_chat(messages, **kw):
            return types.SimpleNamespace(
                content=(
                    '{"duplicates": ["갤럭시S26", "GALAXYS26"], '
                    '"canonical": "갤럭시S26", "outliers": ["S26 Ultra"], '
                    '"reason": "동일 모델"}'
                ),
                backend="openai",
                model="x",
            )

        monkeypatch.setattr("app.ai.llm.chat", fake_chat)
        db = SessionLocal()
        try:
            v = mcmod.validate_cluster(db, type_id, ids)
            dup = {db.get(Entity, i).value for i in v["duplicate_ids"]}
            out = {db.get(Entity, i).value for i in v["outlier_ids"]}
            assert dup == {"갤럭시S26", "GALAXYS26"}
            assert out == {"S26 Ultra"}
            assert db.get(Entity, v["canonical_id"]).value == "갤럭시S26"
        finally:
            db.close()
    finally:
        _cleanup(type_id)


def test_merge_writes_audit_log(monkeypatch):
    """merge_entities(merged_by_user_id=..) 가 entity_merges 감사 로그를 남긴다."""
    monkeypatch.setattr("app.config.settings.embedding_backend", "mock")
    type_id, ids = _mk_axis_with(["갤럭시S26", "GALAXYS26"])
    try:
        db = SessionLocal()
        try:
            src, into = db.get(Entity, ids[1]), db.get(Entity, ids[0])
            services.merge_entities(db, src=src, into=into, merged_by_user_id=ADMIN)
            log = (
                db.query(EntityMerge)
                .filter(EntityMerge.type_id == type_id)
                .one_or_none()
            )
            assert log is not None
            assert log.src_value == "GALAXYS26"
            assert log.into_entity_id == ids[0]
            assert log.merged_by_user_id == ADMIN
            # src 값이 into 의 별칭으로 흡수됐는지(기존 merge 동작).
            assert "GALAXYS26" in (log.absorbed_aliases or [])
        finally:
            db.close()
    finally:
        _cleanup(type_id)
