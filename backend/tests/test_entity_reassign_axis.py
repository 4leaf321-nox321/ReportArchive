"""엔티티 축 이동 — POST /api/entities/bulk-reassign-axis.

잘못된 축에 만들어진 값을 올바른 축으로 이관한다. 태깅(report_entities)은
entity_id 기준이라 자동으로 따라온다. 대상 축에 같은 값이 이미 있으면 그 값으로
병합(원본 삭제), 없으면 축만 바꿔 이사. 형식 불일치는 건너뜀.
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


def _mk_axis(c, label, value_pattern=None):
    body = {"slug": "tstra_" + uuid.uuid4().hex[:8], "label": label}
    r = c.post("/api/entity-types", headers=_h(), json=body)
    assert r.status_code in (200, 201), r.text
    tid = r.json()["data"]["id"]
    if value_pattern:
        r = c.patch(
            f"/api/entity-types/{tid}",
            headers=_h(),
            json={"value_pattern": value_pattern},
        )
        assert r.status_code == 200, r.text
    return tid


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


def _list_ids(c, type_id):
    r = c.get(
        "/api/entities",
        headers=_h(),
        params={"type_id": type_id, "include_deprecated": True, "with_usage": True},
    )
    return {e["id"]: e for e in r.json()["data"]["items"]}


def test_reassign_moves_merges_and_skips():
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:6]
    axis_a = axis_b = axis_num = None
    rids = []
    ent_ids = []
    try:
        axis_a = _mk_axis(c, "출발축 " + sfx)
        axis_b = _mk_axis(c, "대상축 " + sfx)
        # 숫자만 허용하는 축 — 형식 불일치 건너뜀 검증용.
        axis_num = _mk_axis(c, "숫자축 " + sfx, value_pattern=r"[0-9]+")

        # --- 경로 1: 충돌 없는 이사 ---
        x = _mk_entity(c, axis_a, "MOVE-" + sfx)  # A 축, 대상 B 에 없음
        ent_ids.append(x)
        rep1 = _create_report(c, "이사대상 " + sfx)
        rids.append(rep1["id"])
        _tag(rep1["id"], [x])

        # --- 경로 2: 대상 축에 같은 값 존재 → 병합(원본 삭제) ---
        y_a = _mk_entity(c, axis_a, "DUP-" + sfx)  # A 축
        y_b = _mk_entity(c, axis_b, "DUP-" + sfx)  # B 축(대상에 이미 존재)
        ent_ids += [y_a, y_b]
        rep2 = _create_report(c, "병합대상 " + sfx)
        rids.append(rep2["id"])
        _tag(rep2["id"], [y_a])

        # --- 경로 3: 형식 불일치 → 건너뜀 (문자 값을 숫자축으로) ---
        z = _mk_entity(c, axis_a, "TEXT-" + sfx)
        ent_ids.append(z)

        # 실행: X, Y_A 는 B 로 이관 요청.
        r = c.post(
            "/api/entities/bulk-reassign-axis",
            headers=_h(),
            json={"entity_ids": [x, y_a], "target_type_id": axis_b},
        )
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        assert data["moved_ids"] == [x]  # 충돌 없어 이사
        assert data["merged_ids"] == [y_a]  # 대상에 같은 값 → 병합
        assert data["skipped"] == []

        # X 는 이제 B 축에 있고, 태깅(usage)이 따라왔다.
        b_rows = _list_ids(c, axis_b)
        assert x in b_rows
        assert b_rows[x]["usage_count"] == 1
        # A 축에는 X 가 없다(이사됨).
        assert x not in _list_ids(c, axis_a)
        # Y_A 는 사라지고, B 의 Y_B 가 rep2 를 흡수했다.
        assert y_a not in _list_ids(c, axis_a)
        assert y_a not in b_rows
        assert b_rows[y_b]["usage_count"] == 1

        # 형식 불일치 건너뜀: Z(문자)를 숫자축으로 → skipped 1, moved/merged 0.
        r = c.post(
            "/api/entities/bulk-reassign-axis",
            headers=_h(),
            json={"entity_ids": [z], "target_type_id": axis_num},
        )
        assert r.status_code == 200, r.text
        d2 = r.json()["data"]
        assert d2["moved_ids"] == [] and d2["merged_ids"] == []
        assert [s["id"] for s in d2["skipped"]] == [z]
        # Z 는 여전히 A 축에 그대로.
        assert z in _list_ids(c, axis_a)

        # 이미 대상 축이면 건너뜀.
        r = c.post(
            "/api/entities/bulk-reassign-axis",
            headers=_h(),
            json={"entity_ids": [x], "target_type_id": axis_b},
        )
        assert [s["reason"] for s in r.json()["data"]["skipped"]] == ["이미 대상 축입니다"]
    finally:
        for rid in rids:
            _purge_report(rid)
        for eid in ent_ids:
            c.delete(f"/api/entities/{eid}", headers=_h())
        for tid in (axis_a, axis_b, axis_num):
            if tid:
                c.delete(f"/api/entity-types/{tid}", headers=_h())


def test_reassign_requires_admin():
    c = TestClient(app)
    r = c.post(
        "/api/entities/bulk-reassign-axis",
        headers=_h(uid=3),
        json={"entity_ids": [1], "target_type_id": 1},
    )
    assert r.status_code == 403, r.text
