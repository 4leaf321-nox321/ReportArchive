"""온톨로지 강화 A0.3 스텝1 — kind_class(객체 분류) API + record 축 시드.

축을 record 로 만들고 수정하는 API, record 축 값에 속성 검증(A0.1 재사용)이 걸리는지,
그리고 마이그 p66 이 시드한 record 축(project 등)이 kind_class=record 로 존재하는지 확인.
일회용 축은 정리한다. 통합 테스트라 격리 없는 dev DB 에 직접 붙는다.
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token

ADMIN = 2


def _h(uid=ADMIN):
    return {"Authorization": f"Bearer {create_access_token(uid)}"}


def _find_type(c, slug):
    r = c.get("/api/entity-types", headers=_h())
    assert r.status_code == 200, r.text
    return next((t for t in r.json()["data"]["items"] if t["slug"] == slug), None)


def test_kind_class_crud_and_record_validation():
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    slug = "tstk_" + sfx
    type_id = None
    ent_id = None
    try:
        # 1. record 축으로 생성 → read 에 kind_class 반영
        r = c.post(
            "/api/entity-types",
            headers=_h(),
            json={"slug": slug, "label": "테스트레코드", "kind_class": "record"},
        )
        assert r.status_code in (200, 201), r.text
        type_id = r.json()["data"]["id"]
        assert r.json()["data"]["kind_class"] == "record"
        assert _find_type(c, slug)["kind_class"] == "record"

        # 2. PATCH 로 reference 로 낮췄다 다시 record 로
        r = c.patch(
            f"/api/entity-types/{type_id}", headers=_h(),
            json={"kind_class": "reference"},
        )
        assert r.status_code == 200, r.text
        assert _find_type(c, slug)["kind_class"] == "reference"
        r = c.patch(
            f"/api/entity-types/{type_id}", headers=_h(),
            json={"kind_class": "record"},
        )
        assert r.status_code == 200 and _find_type(c, slug)["kind_class"] == "record"

        # 3. record 축에 속성정의(enum 필수) → 값 생성 시 A0.1 검증이 걸린다
        r = c.post(
            f"/api/entity-types/{type_id}/properties", headers=_h(),
            json={"key": "grade", "label": "등급", "data_type": "enum",
                  "required": True,
                  "enum_options": [{"value": "A", "label": "A"},
                                   {"value": "B", "label": "B"}]},
        )
        assert r.status_code in (200, 201), r.text
        # 유효 → 생성됨
        r = c.post(
            "/api/entities", headers=_h(),
            json={"type_id": type_id, "value": "REC-" + sfx,
                  "properties": {"grade": "A"}},
        )
        assert r.status_code in (200, 201), r.text
        ent_id = r.json()["data"]["id"]
        assert r.json()["data"]["properties"]["grade"] == "A"
        # 필수 속성에 빈 값 → 400 (속성을 보내면 A0.1 검증이 required 를 강제).
        # (properties 를 통째로 비우면 검증을 건너뛰는 건 A0.1 의 의도된 동작 —
        #  프론트가 저장 버튼으로 게이팅. 여기선 값이 실린 경로를 검증한다.)
        r = c.post(
            "/api/entities", headers=_h(),
            json={"type_id": type_id, "value": "REC2-" + sfx,
                  "properties": {"grade": ""}},
        )
        assert r.status_code == 400, r.text
        # enum 밖 → 400
        r = c.post(
            "/api/entities", headers=_h(),
            json={"type_id": type_id, "value": "REC3-" + sfx,
                  "properties": {"grade": "Z"}},
        )
        assert r.status_code == 400, r.text

        # 4. 마이그 p66 시드 확인 — project record 축 + 속성정의 존재
        proj = _find_type(c, "project")
        assert proj is not None and proj["kind_class"] == "record", "project 축 시드 누락"
        rp = c.get(f"/api/entity-types/{proj['id']}/properties", headers=_h())
        assert rp.status_code == 200
        keys = {d["key"] for d in rp.json()["data"]["items"]}
        # 시드 후 운영에서 지운 속성은 여기 넣지 말 것 — budget(예산)이 그렇게 빠졌다.
        # 축이 시드됐는지만 보고, 지울 수 있는 개별 속성엔 기대지 않는다.
        assert {"status", "period_from"} <= keys, keys
    finally:
        if ent_id is not None:
            c.delete(f"/api/entities/{ent_id}", headers=_h())
        if type_id is not None:
            # 속성정의 먼저 정리
            rp = c.get(f"/api/entity-types/{type_id}/properties", headers=_h())
            if rp.status_code == 200:
                for d in rp.json()["data"]["items"]:
                    c.delete(
                        f"/api/entity-types/{type_id}/properties/{d['id']}",
                        headers=_h(),
                    )
            c.delete(f"/api/entity-types/{type_id}", headers=_h())
