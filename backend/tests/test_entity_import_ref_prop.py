"""표(붙여넣기) 임포트에서 entity_ref 속성을 이름으로 입력 → id 자동 해소.

시험항목처럼 "다른 엔티티를 가리키는 속성"(data_type=entity_ref, 대상 축 지정)을
표에 이름으로 넣어도, 대상 축에서 찾아 id 로 치환해 저장되는지 확인한다. 못 찾은
이름은 그 행만 error(무엇을 못 찾았는지 명시).
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token

ADMIN = {
    "Authorization": f"Bearer {create_access_token(2)}",
    "X-Workspace-Slug": "dx",
}


def _find(c, type_id, q):
    r = c.post("/api/entities/search", headers=ADMIN, json={"type_id": type_id, "q": q})
    return r.json()["data"]["items"]


def test_paste_entity_ref_prop_resolves_by_name():
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    ref_axis = rec_axis = None
    made = []
    try:
        # 대상 축(시험) + 값 하나(인장시험)
        ref_slug = "reftest_" + sfx
        ref_axis = c.post(
            "/api/entity-types",
            headers=ADMIN,
            json={"slug": ref_slug, "label": "시험"},
        ).json()["data"]["id"]
        item_id = c.post(
            "/api/entities",
            headers=ADMIN,
            json={"type_id": ref_axis, "value": "인장시험-" + sfx},
        ).json()["data"]["id"]
        made.append(item_id)

        # record 축(시험결과) + entity_ref 속성(시험항목 → 시험 축)
        rec_axis = c.post(
            "/api/entity-types",
            headers=ADMIN,
            json={"slug": "rectest_" + sfx, "label": "시험결과", "kind_class": "record"},
        ).json()["data"]["id"]
        c.post(
            f"/api/entity-types/{rec_axis}/properties",
            headers=ADMIN,
            json={
                "key": "test_item",
                "label": "시험항목",
                "data_type": "entity_ref",
                "ref_type_slug": ref_slug,
            },
        )

        # 표 입력: 시험항목을 **이름**으로. 한 행은 존재하는 이름, 한 행은 없는 이름.
        good = "결과-" + sfx
        bad = "결과X-" + sfx
        body = {
            "columns": ["c0", "c1"],
            "rows": [
                [good, "인장시험-" + sfx],   # 이름 → id 해소 성공
                [bad, "없는시험-" + sfx],     # 해소 실패 → 이 행 error
            ],
            "mapping": {
                "type_id": rec_axis,
                "value_column": "c0",
                "property_columns": {"c1": "test_item"},
                "relation_columns": [],
                "dry_run": False,
            },
        }
        r = c.post("/api/entities/import/rows", headers=ADMIN, json=body)
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        s = data["summary"]
        # 한 건 생성, 한 건 error.
        assert s["create"] == 1 and s["error"] == 1, s

        # 생성된 결과의 속성이 이름이 아니라 대상 엔티티 id 로 저장됐는지 확인.
        rec = _find(c, rec_axis, good)
        assert len(rec) == 1, rec
        made.append(rec[0]["id"])
        assert rec[0]["properties"]["test_item"] == item_id

        # 실패 행 메시지에 무엇을 못 찾았는지 나온다.
        err_row = next(x for x in data["rows"] if x["status"] == "error")
        assert "시험항목" in err_row["messages"][0]
    finally:
        for eid in made:
            c.delete(f"/api/entities/{eid}", headers=ADMIN)
        for tid in (rec_axis, ref_axis):
            if tid:
                rp = c.get(f"/api/entity-types/{tid}/properties", headers=ADMIN)
                if rp.status_code == 200:
                    for pd in rp.json()["data"]["items"]:
                        c.delete(
                            f"/api/entity-types/{tid}/properties/{pd['id']}",
                            headers=ADMIN,
                        )
                c.delete(f"/api/entity-types/{tid}", headers=ADMIN)
