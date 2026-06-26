"""관계 타입 레지스트리(p55, D-1) — relation_types + add_relation 일반화.

시드된 타입 조회, 축 제약(src/dst axis) 강제, 미등록 타입 거부, acyclic 타입의
순환 가드를 서비스 레이어로 검증한다. 라우트는 GET(목록)만 가볍게 확인.

실행 전제: 공유 Postgres 가 head(p55)까지 마이그레이션.
    cd backend && ./venv/bin/alembic upgrade head
    python -m pytest tests/test_relation_types.py -v
"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.entities import services
from app.modules.entities.models import Entity, EntityRelation, EntityType
from app.modules.entities.schemas import EntityCreate


def _h(uid=1):
    return {"Authorization": f"Bearer {create_access_token(uid)}"}


def _axis_id(db, slug):
    return db.execute(
        select(EntityType.id).where(EntityType.slug == slug)
    ).scalar_one()


def _mk(db, axis_slug):
    """그 축에 고유 값 엔티티 1개 생성."""
    e = services.create_entity(
        db,
        EntityCreate(type_id=_axis_id(db, axis_slug), value="GR" + uuid.uuid4().hex[:8]),
        creator_user_id=1,
    )
    return e


def test_relation_types_seeded_via_api():
    client = TestClient(app)
    r = client.get("/api/relation-types", headers=_h())
    assert r.status_code == 200, r.text
    slugs = {it["slug"] for it in r.json()["data"]["items"]}
    assert {"part_of", "tested_by", "simulated_by", "has_defect",
            "occurs_at", "supersedes", "variant_of"} <= slugs


def test_axis_constraint_enforced():
    db = SessionLocal()
    created = []
    try:
        part = _mk(db, "part"); created.append(part.id)
        model = _mk(db, "model"); created.append(model.id)
        rel_test = _mk(db, "rel_test"); created.append(rel_test.id)

        # part_of: part → model 은 허용 축(src∈{part,bom}, dst∈{model,part}).
        rel = services.add_relation(db, src=part, dst=model, relation="part_of")
        assert rel.relation == "part_of"

        # tested_by: dst 는 rel_test 여야 함 → model 을 dst 로 주면 거부.
        with pytest.raises(ValueError, match="도착 축"):
            services.add_relation(db, src=part, dst=model, relation="tested_by")
        # 올바른 축(part → rel_test)은 통과.
        ok = services.add_relation(db, src=part, dst=rel_test, relation="tested_by")
        assert ok.relation == "tested_by"
    finally:
        db.query(EntityRelation).filter(
            EntityRelation.src_entity_id.in_(created)
            | EntityRelation.dst_entity_id.in_(created)
        ).delete(synchronize_session=False)
        db.query(Entity).filter(Entity.id.in_(created)).delete(
            synchronize_session=False
        )
        db.commit()
        db.close()


def test_unknown_relation_rejected():
    db = SessionLocal()
    created = []
    try:
        a = _mk(db, "part"); created.append(a.id)
        b = _mk(db, "model"); created.append(b.id)
        with pytest.raises(ValueError, match="지원하지 않는"):
            services.add_relation(db, src=a, dst=b, relation="bogus_rel")
    finally:
        db.query(Entity).filter(Entity.id.in_(created)).delete(
            synchronize_session=False
        )
        db.commit()
        db.close()


def test_acyclic_guard_on_part_of():
    db = SessionLocal()
    created = []
    try:
        # 같은 축(part) 안에서 part_of 체인을 만들어 순환을 시도(part dst 허용됨).
        a = _mk(db, "part"); created.append(a.id)
        b = _mk(db, "part"); created.append(b.id)
        services.add_relation(db, src=a, dst=b, relation="part_of")  # a part_of b
        with pytest.raises(ValueError, match="순환"):
            services.add_relation(db, src=b, dst=a, relation="part_of")  # b part_of a → 순환
    finally:
        db.query(EntityRelation).filter(
            EntityRelation.src_entity_id.in_(created)
            | EntityRelation.dst_entity_id.in_(created)
        ).delete(synchronize_session=False)
        db.query(Entity).filter(Entity.id.in_(created)).delete(
            synchronize_session=False
        )
        db.commit()
        db.close()
