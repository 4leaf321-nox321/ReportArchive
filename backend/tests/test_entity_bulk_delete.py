"""엔티티 일괄 삭제 — POST /api/entities/bulk-delete.

삭제 가능한 값은 지우고, 보고서가 사용 중인 값은 건너뛴다(부분 성공). 없는 id 도
건너뜀으로 처리. 일회용 축을 만들어 검증하고 끝나면 정리한다.
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.entities import services as entity_services
from app.modules.reports.models import Report

ADMIN = 2  # is_system_admin


def _h(uid=ADMIN, slug="dx"):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": slug,
    }


def _create_report(c, title):
    tpl = c.get("/api/templates", headers=_h()).json()["data"][0]
    return c.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": title,
            "tags": [],
        },
    ).json()["data"]


def _tag(rid, entity_ids):
    db = SessionLocal()
    try:
        entity_services.set_report_entities(db, report_id=rid, entity_ids=entity_ids)
        db.commit()
    finally:
        db.close()


def _purge_report(rid):
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        if r:
            db.delete(r)  # report_entities CASCADE
            db.commit()
    finally:
        db.close()


def test_bulk_delete_deletes_free_skips_in_use():
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    type_id = None
    ent_ids = []
    rid = None
    try:
        # 1. 일회용 축 + 엔티티 3개
        r = c.post(
            "/api/entity-types",
            headers=_h(),
            json={"slug": "tstbd_" + sfx, "label": "일괄삭제축"},
        )
        assert r.status_code in (200, 201), r.text
        type_id = r.json()["data"]["id"]
        for v in ("BD-A-" + sfx, "BD-B-" + sfx, "BD-C-" + sfx):
            r = c.post(
                "/api/entities",
                headers=_h(),
                json={"type_id": type_id, "value": v},
            )
            assert r.status_code in (200, 201), r.text
            ent_ids.append(r.json()["data"]["id"])

        # 2. 세 번째 값을 보고서에 태깅 → 사용 중(삭제 차단 대상)
        rep = _create_report(c, "일괄삭제 사용중 " + sfx)
        rid = rep["id"]
        _tag(rid, [ent_ids[2]])

        # 3. 없는 id 하나를 섞어 셋+1 건을 일괄 삭제 요청
        missing = 999_000_000
        r = c.post(
            "/api/entities/bulk-delete",
            headers=_h(),
            json={"entity_ids": [ent_ids[0], ent_ids[1], ent_ids[2], missing]},
        )
        assert r.status_code == 200, r.text
        data = r.json()["data"]

        # 자유로운 두 건만 삭제, 사용 중 + 없는 id 는 건너뜀.
        assert set(data["deleted_ids"]) == {ent_ids[0], ent_ids[1]}
        skipped_ids = {s["id"] for s in data["skipped"]}
        assert skipped_ids == {ent_ids[2], missing}

        # 4. 실제로 사라졌는지 확인 — 사용 중 값만 목록에 남는다.
        r = c.get(
            "/api/entities",
            headers=_h(),
            params={"type_id": type_id, "include_deprecated": True},
        )
        remaining = {e["id"] for e in r.json()["data"]["items"]}
        assert ent_ids[0] not in remaining
        assert ent_ids[1] not in remaining
        assert ent_ids[2] in remaining
    finally:
        if rid:
            _purge_report(rid)
        # 남은 엔티티 + 축 정리
        for eid in ent_ids:
            c.delete(f"/api/entities/{eid}", headers=_h())
        if type_id:
            c.delete(f"/api/entity-types/{type_id}", headers=_h())


def test_bulk_delete_requires_admin():
    c = TestClient(app)
    # uid=3 = 비-admin(conftest 시드) → 403
    r = c.post(
        "/api/entities/bulk-delete",
        headers=_h(uid=3),
        json={"entity_ids": [1]},
    )
    assert r.status_code == 403, r.text
