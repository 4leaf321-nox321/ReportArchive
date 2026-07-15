"""엔티티 태깅 이동 — POST /api/entities/{id}/move-taggings.

이 값이 걸린 모든 보고서를 같은 축의 다른 값으로 재태깅하되 원본은 남긴다
("모두 해제"의 이동 버전). 다른 축 대상은 400, 중복 링크는 dedupe.
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.entities import services as entity_services
from app.modules.reports.models import Report

ADMIN = 2


def _h(uid=ADMIN, slug="dx"):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": slug,
    }


def _mk_axis(c, label):
    r = c.post(
        "/api/entity-types",
        headers=_h(),
        json={"slug": "tstmt_" + uuid.uuid4().hex[:8], "label": label},
    )
    assert r.status_code in (200, 201), r.text
    return r.json()["data"]["id"]


def _mk_entity(c, type_id, value):
    r = c.post("/api/entities", headers=_h(), json={"type_id": type_id, "value": value})
    assert r.status_code in (200, 201), r.text
    return r.json()["data"]["id"]


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
            db.delete(r)
            db.commit()
    finally:
        db.close()


def _usage(c, type_id):
    r = c.get(
        "/api/entities",
        headers=_h(),
        params={"type_id": type_id, "include_deprecated": True, "with_usage": True},
    )
    return {e["id"]: e for e in r.json()["data"]["items"]}


def test_move_taggings_keeps_source_and_dedupes():
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:6]
    axis = axis2 = None
    rids = []
    ent_ids = []
    try:
        axis = _mk_axis(c, "이동축 " + sfx)
        a = _mk_entity(c, axis, "SRC-" + sfx)
        b = _mk_entity(c, axis, "DST-" + sfx)
        ent_ids += [a, b]

        rep1 = _create_report(c, "이동보고서1 " + sfx)  # A 만
        rep2 = _create_report(c, "이동보고서2 " + sfx)  # A + B (dedupe 대상)
        rids += [rep1["id"], rep2["id"]]
        _tag(rep1["id"], [a])
        _tag(rep2["id"], [a, b])

        # A → B 로 태깅 이동.
        r = c.post(
            f"/api/entities/{a}/move-taggings",
            headers=_h(),
            json={"into_id": b},
        )
        assert r.status_code == 200, r.text
        # rep1 은 새로 B 를 얻음(1건), rep2 는 이미 B 가 있어 dedupe(옮김 0).
        assert r.json()["data"]["moved_count"] == 1

        rows = _usage(c, axis)
        # A 는 남아 있고(삭제 안 됨) 사용 0건.
        assert a in rows and rows[a]["usage_count"] == 0
        # B 는 두 보고서 모두 보유(rep1 이동 + rep2 기존).
        assert rows[b]["usage_count"] == 2

        # 이제 A 는 사용 0건이라 정식 삭제가 된다.
        r = c.delete(f"/api/entities/{a}", headers=_h())
        assert r.status_code == 200, r.text
        ent_ids.remove(a)

        # --- 일부만 이동 ---
        # 새 값 D 를 세 보고서에 태깅한 뒤, 그중 두 건만 B 로 옮긴다.
        d = _mk_entity(c, axis, "PARTIAL-" + sfx)
        ent_ids.append(d)
        rep3 = _create_report(c, "부분이동1 " + sfx)
        rep4 = _create_report(c, "부분이동2 " + sfx)
        rep5 = _create_report(c, "부분이동3 " + sfx)
        rids += [rep3["id"], rep4["id"], rep5["id"]]
        _tag(rep3["id"], [d])
        _tag(rep4["id"], [d])
        _tag(rep5["id"], [d])

        r = c.post(
            f"/api/entities/{d}/move-taggings",
            headers=_h(),
            json={"into_id": b, "report_ids": [rep3["id"], rep4["id"]]},
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["moved_count"] == 2
        rows = _usage(c, axis)
        # D 에는 옮기지 않은 rep5 한 건만 남는다.
        assert rows[d]["usage_count"] == 1
        # B 는 앞선 2건 + 이번 2건 = 4건.
        assert rows[b]["usage_count"] == 4

        # 다른 축 대상 → 400.
        axis2 = _mk_axis(c, "다른축 " + sfx)
        other = _mk_entity(c, axis2, "OTHER-" + sfx)
        ent_ids.append(other)
        r = c.post(
            f"/api/entities/{b}/move-taggings",
            headers=_h(),
            json={"into_id": other},
        )
        assert r.status_code == 400, r.text
    finally:
        for rid in rids:
            _purge_report(rid)
        for eid in ent_ids:
            c.delete(f"/api/entities/{eid}", headers=_h())
        for tid in (axis, axis2):
            if tid:
                c.delete(f"/api/entity-types/{tid}", headers=_h())


def test_move_taggings_bulk_batch():
    """벌크 SQL 경로 — 여러 보고서를 한 번에 이동(dedup 섞임 포함) 정확성."""
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:6]
    axis = None
    rids = []
    ent_ids = []
    try:
        axis = _mk_axis(c, "배치축 " + sfx)
        a = _mk_entity(c, axis, "BULK-SRC-" + sfx)
        b = _mk_entity(c, axis, "BULK-DST-" + sfx)
        ent_ids += [a, b]

        n = 30
        for i in range(n):
            rep = _create_report(c, f"배치{i}-{sfx}")
            rids.append(rep["id"])
            # 짝수 보고서는 B 도 미리 달아 dedup 대상으로.
            _tag(rep["id"], [a, b] if i % 2 == 0 else [a])

        r = c.post(
            f"/api/entities/{a}/move-taggings",
            headers=_h(),
            json={"into_id": b},
        )
        assert r.status_code == 200, r.text
        # 홀수 15건만 새로 옮겨짐(짝수 15건은 이미 B 보유 → dedup, 옮김 0).
        assert r.json()["data"]["moved_count"] == 15

        rows = _usage(c, axis)
        assert rows[a]["usage_count"] == 0  # 원본은 남되 사용 0
        assert rows[b]["usage_count"] == n  # 전 보고서가 B 로 귀결
    finally:
        for rid in rids:
            _purge_report(rid)
        for eid in ent_ids:
            c.delete(f"/api/entities/{eid}", headers=_h())
        if axis:
            c.delete(f"/api/entity-types/{axis}", headers=_h())


def test_move_taggings_requires_admin():
    c = TestClient(app)
    r = c.post(
        "/api/entities/1/move-taggings",
        headers=_h(uid=3),
        json={"into_id": 2},
    )
    assert r.status_code == 403, r.text
