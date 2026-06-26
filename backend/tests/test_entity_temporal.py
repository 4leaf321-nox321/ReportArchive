"""엔티티 시간 차원(p56) — 축별 연도 정책 필터 + 연도 세트 CRUD.

list_entities(year=) 가 entity_types.temporal_kind 에 따라 다르게 거르는지
(evergreen 무시 / lifecycle 유효구간 / yearly 연도세트 / derived 보고서연도),
연도 세트 get/set 과 create 시 yearly 축 올해 자동배정, 그리고 GET/PUT
/entities/{id}/years 엔드포인트(인증·admin 게이트)를 검증한다.

실행 전제: 공유 Postgres 가 head(p56)까지 마이그레이션.
    cd backend && ./venv/bin/alembic upgrade head
    python -m pytest tests/test_entity_temporal.py -v
"""
from __future__ import annotations

import uuid
from datetime import date, datetime

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.entities import services
from app.modules.entities import services as entity_services
from app.modules.entities.models import (
    Entity,
    EntityRelation,
    EntityStatus,
    EntityTemporalKind,
    EntityType,
    EntityYear,
    ReportEntity,
)
from app.modules.entities.schemas import EntityCreate, EntityUpdate
from app.modules.reports.models import Report


# uid=2 = system admin, uid=3 = non-admin (conftest 시드). 엔티티 라우트는
# 워크스페이스 불필요(entity_actor=auth only)지만 보고서 생성엔 slug 필요.
def _h(uid=2, slug="dx"):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": slug,
    }


def _axis(db, kind: EntityTemporalKind) -> EntityType:
    et = EntityType(
        slug="tmp_" + uuid.uuid4().hex[:8],
        label="임시축",
        temporal_kind=kind,
    )
    db.add(et)
    db.commit()
    db.refresh(et)
    return et


def _val(db, type_id, *, vfrom=None, vto=None) -> Entity:
    e = Entity(
        type_id=type_id,
        value="TV" + uuid.uuid4().hex[:8],
        status=EntityStatus.active,
        valid_from_year=vfrom,
        valid_to_year=vto,
        created_by_user_id=2,
    )
    db.add(e)
    db.commit()
    db.refresh(e)
    return e


def _list(db, type_id, year):
    """list_entities(year=) 가 돌려준 엔티티 id 집합."""
    rows = services.list_entities(db, type_id=type_id, year=year)
    return {e.id for e in rows}


def _cleanup(db, ent_ids, type_ids):
    if ent_ids:
        db.query(ReportEntity).filter(
            ReportEntity.entity_id.in_(ent_ids)
        ).delete(synchronize_session=False)
        db.query(EntityRelation).filter(
            EntityRelation.src_entity_id.in_(ent_ids)
            | EntityRelation.dst_entity_id.in_(ent_ids)
        ).delete(synchronize_session=False)
        db.query(EntityYear).filter(
            EntityYear.entity_id.in_(ent_ids)
        ).delete(synchronize_session=False)
        db.query(Entity).filter(Entity.id.in_(ent_ids)).delete(
            synchronize_session=False
        )
    if type_ids:
        db.query(EntityType).filter(EntityType.id.in_(type_ids)).delete(
            synchronize_session=False
        )
    db.commit()


def test_evergreen_year_is_noop():
    """evergreen 축은 연도와 무관 — 어떤 year 를 줘도 항상 노출."""
    db = SessionLocal()
    ids, tids = [], []
    try:
        et = _axis(db, EntityTemporalKind.evergreen)
        tids.append(et.id)
        e = _val(db, et.id)
        ids.append(e.id)
        assert e.id in _list(db, et.id, year=2000)
        assert e.id in _list(db, et.id, year=2026)
        assert e.id in _list(db, et.id, year=None)  # 필터 미지정
    finally:
        _cleanup(db, ids, tids)
        db.close()


def test_lifecycle_range_filter():
    """lifecycle 축 — 유효구간(NULL=개방)에 드는 해에만 노출. update_entity 경로도 검증."""
    db = SessionLocal()
    ids, tids = [], []
    try:
        et = _axis(db, EntityTemporalKind.lifecycle)
        tids.append(et.id)
        e_open = _val(db, et.id)  # NULL/NULL → 항상
        e_22_24 = _val(db, et.id, vfrom=2022, vto=2024)
        # update_entity 로 구간 설정(서비스 경로 커버): 2023~진행중
        e_from23 = _val(db, et.id)
        services.update_entity(
            db, e_from23, EntityUpdate(valid_from_year=2023)
        )
        ids += [e_open.id, e_22_24.id, e_from23.id]

        y2023 = _list(db, et.id, year=2023)
        assert {e_open.id, e_22_24.id, e_from23.id} <= y2023

        y2021 = _list(db, et.id, year=2021)
        assert e_open.id in y2021
        assert e_22_24.id not in y2021  # from 2022 > 2021
        assert e_from23.id not in y2021  # from 2023 > 2021

        y2025 = _list(db, et.id, year=2025)
        assert e_open.id in y2025
        assert e_22_24.id not in y2025  # to 2024 < 2025
        assert e_from23.id in y2025  # 진행중(to NULL)
    finally:
        _cleanup(db, ids, tids)
        db.close()


def test_yearly_set_and_autoassign_current_year():
    """yearly 축 — create 시 올해 자동배정, set_entity_years 로 명시 교체(replace)."""
    db = SessionLocal()
    ids, tids = [], []
    try:
        et = _axis(db, EntityTemporalKind.yearly)
        tids.append(et.id)
        cur = datetime.utcnow().year

        # create_entity → 올해 자동배정.
        created = services.create_entity(
            db,
            EntityCreate(type_id=et.id, value="YR" + uuid.uuid4().hex[:8]),
            creator_user_id=2,
        )
        ids.append(created.id)
        assert services.get_entity_years(db, created.id) == [cur]
        assert created.id in _list(db, et.id, year=cur)
        assert created.id not in _list(db, et.id, year=cur - 1)

        # 명시 세트로 교체 — 불연속(2023, 2025), 올해는 빠짐.
        out = services.set_entity_years(db, created, [2025, 2023, 2023])
        assert out == [2023, 2025]  # 정렬·중복제거
        assert created.id in _list(db, et.id, year=2023)
        assert created.id in _list(db, et.id, year=2025)
        assert created.id not in _list(db, et.id, year=2024)
        assert created.id not in _list(db, et.id, year=cur)  # 교체됨
    finally:
        _cleanup(db, ids, tids)
        db.close()


def test_derived_from_report_year():
    """derived 축 — 그 값이 쓰인 보고서(report_date)의 연도에서만 노출."""
    client = TestClient(app)
    db = SessionLocal()
    ids, tids = [], []
    rid = None
    try:
        et = _axis(db, EntityTemporalKind.derived)
        tids.append(et.id)
        e = _val(db, et.id)
        ids.append(e.id)

        # 아직 어느 보고서에도 안 쓰임 → 특정 연도 필터에 안 잡힘.
        assert e.id not in _list(db, et.id, year=2023)

        # 보고서 생성(uid=2 admin) + report_date=2023 강제 + 태깅.
        tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
        rid = client.post(
            "/api/reports",
            headers=_h(),
            json={
                "template_id": tpl["template_id"],
                "template_version": tpl["version"],
                "title": "TEMPORAL " + uuid.uuid4().hex[:6],
                "tags": [],
            },
        ).json()["data"]["id"]
        r = db.get(Report, rid)
        r.report_date = date(2023, 6, 1)
        db.commit()
        entity_services.set_report_entities(db, report_id=rid, entity_ids=[e.id])
        db.commit()

        assert e.id in _list(db, et.id, year=2023)
        assert e.id not in _list(db, et.id, year=2022)
        assert e.id not in _list(db, et.id, year=2024)
    finally:
        if rid is not None:
            r = db.get(Report, rid)
            if r:
                db.delete(r)  # report_entities CASCADE
                db.commit()
        _cleanup(db, ids, tids)
        db.close()


def test_years_endpoint_roundtrip_and_admin_gate():
    """GET /entities/{id}/years (인증) + PUT (admin) 라운드트립, 비admin 은 403.
    GET /api/entities?year= 라우트 파라미터도 함께 확인."""
    client = TestClient(app)
    db = SessionLocal()
    ids, tids = [], []
    try:
        et = _axis(db, EntityTemporalKind.yearly)
        tids.append(et.id)
        e = _val(db, et.id)
        ids.append(e.id)

        # 비-admin PUT → 403.
        r = client.put(
            f"/api/entities/{e.id}/years",
            headers=_h(uid=3),
            json={"years": [2024]},
        )
        assert r.status_code == 403, r.text

        # admin PUT → 저장(정렬·중복제거).
        r = client.put(
            f"/api/entities/{e.id}/years",
            headers=_h(uid=2),
            json={"years": [2025, 2024, 2024]},
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["years"] == [2024, 2025]

        # GET(인증) 로 재확인.
        r = client.get(f"/api/entities/{e.id}/years", headers=_h(uid=2))
        assert r.status_code == 200, r.text
        assert r.json()["data"]["years"] == [2024, 2025]

        # 라우트 year 파라미터: 2024 면 잡히고 2023 이면 안 잡힘.
        def _api_ids(year):
            resp = client.get(
                "/api/entities",
                params={"type_id": et.id, "year": year},
                headers=_h(uid=2),
            )
            assert resp.status_code == 200, resp.text
            return {it["id"] for it in resp.json()["data"]["items"]}

        assert e.id in _api_ids(2024)
        assert e.id not in _api_ids(2023)
    finally:
        _cleanup(db, ids, tids)
        db.close()


def test_search_keyword_year_filter():
    """검색의 자료연도(작성연도, report_date) 필터 — year 와 일치하는 보고서만."""
    client = TestClient(app)
    db = SessionLocal()
    rid = None
    try:
        tok = "YRSRCH" + uuid.uuid4().hex[:6].upper()
        tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
        rid = client.post(
            "/api/reports",
            headers=_h(),
            json={
                "template_id": tpl["template_id"],
                "template_version": tpl["version"],
                "title": f"{tok} 작성연도",
                "tags": [],
            },
        ).json()["data"]["id"]
        r = db.get(Report, rid)
        r.report_date = date(2023, 3, 1)
        db.commit()

        def _ids(**params):
            resp = client.get(
                "/api/reports/search",
                params={"q": tok, **params},
                headers=_h(),
            )
            assert resp.status_code == 200, resp.text
            return {h["report"]["id"] for h in resp.json()["data"]["results"]}

        assert rid in _ids()  # 연도 필터 없으면 잡힘
        assert rid in _ids(year=2023)  # 작성연도 일치
        assert rid not in _ids(year=2022)  # 불일치
    finally:
        if rid is not None:
            rr = db.get(Report, rid)
            if rr:
                db.delete(rr)
                db.commit()
        db.close()
