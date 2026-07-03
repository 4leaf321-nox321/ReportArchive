"""온톨로지 강화 A0.1 스텝2 — 속성 정의 CRUD + 엔티티 속성 검증.

일회용 축(entity_type)을 만들어 속성 정의를 붙이고, 엔티티 저장 시 축 스키마로
검증되는지 확인한다. 끝나면 엔티티→정의→축 순으로 정리한다.
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token

ADMIN = 2  # is_system_admin


def _h(uid=ADMIN):
    return {"Authorization": f"Bearer {create_access_token(uid)}"}


def test_property_defs_and_entity_validation():
    c = TestClient(app)
    slug = "tst_" + uuid.uuid4().hex[:8]
    type_id = None
    ent_ids = []
    try:
        # 1. 일회용 축 생성
        r = c.post("/api/entity-types", headers=_h(), json={"slug": slug, "label": "테스트축"})
        assert r.status_code in (200, 201), r.text
        type_id = r.json()["data"]["id"]

        # 2. 속성 정의 추가: 재질(text) + 중량(number/kg, 필수) + 상태(enum)
        for body in (
            {"key": "material", "label": "재질", "data_type": "text"},
            {"key": "weight", "label": "중량", "data_type": "number", "unit": "kg", "required": True},
            {"key": "grade", "label": "등급", "data_type": "enum",
             "enum_options": [{"value": "A", "label": "A급"}, {"value": "B", "label": "B급"}]},
        ):
            r = c.post(f"/api/entity-types/{type_id}/properties", headers=_h(), json=body)
            assert r.status_code in (200, 201), r.text

        # 잘못된 data_type → 400
        r = c.post(f"/api/entity-types/{type_id}/properties", headers=_h(),
                   json={"key": "bad", "label": "x", "data_type": "nope"})
        assert r.status_code == 400, r.text
        # enum 인데 옵션 없음 → 400
        r = c.post(f"/api/entity-types/{type_id}/properties", headers=_h(),
                   json={"key": "e2", "label": "x", "data_type": "enum"})
        assert r.status_code == 400, r.text

        # 3. 정의 목록(인증만) — 3개
        r = c.get(f"/api/entity-types/{type_id}/properties", headers=_h())
        assert r.status_code == 200
        assert len(r.json()["data"]["items"]) == 3

        # 4. 유효한 속성으로 엔티티 생성
        r = c.post("/api/entities", headers=_h(), json={
            "type_id": type_id, "value": "부품-" + uuid.uuid4().hex[:6],
            "properties": {"material": "AL6061", "weight": 1.2, "grade": "A"},
        })
        assert r.status_code in (200, 201), r.text
        data = r.json()["data"]
        ent_ids.append(data["id"])
        assert data["properties"]["material"] == "AL6061"
        assert data["properties"]["weight"] == 1.2
        assert data["properties"]["grade"] == "A"

        # 5. 검증 실패 케이스들 → 400
        base = {"type_id": type_id}
        # 필수(weight) 누락
        r = c.post("/api/entities", headers=_h(),
                   json={**base, "value": "x1-" + uuid.uuid4().hex[:6], "properties": {"material": "AL"}})
        assert r.status_code == 400, r.text
        # weight 숫자 아님
        r = c.post("/api/entities", headers=_h(),
                   json={**base, "value": "x2-" + uuid.uuid4().hex[:6], "properties": {"weight": "heavy"}})
        assert r.status_code == 400, r.text
        # 미정의 키
        r = c.post("/api/entities", headers=_h(),
                   json={**base, "value": "x3-" + uuid.uuid4().hex[:6], "properties": {"weight": 1, "ghost": 1}})
        assert r.status_code == 400, r.text
        # enum 잘못된 값
        r = c.post("/api/entities", headers=_h(),
                   json={**base, "value": "x4-" + uuid.uuid4().hex[:6], "properties": {"weight": 1, "grade": "Z"}})
        assert r.status_code == 400, r.text

        # 6. PATCH 로 속성 교체(검증됨)
        r = c.patch(f"/api/entities/{ent_ids[0]}", headers=_h(),
                    json={"properties": {"weight": 2.5, "material": "STS"}})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["properties"]["weight"] == 2.5
        assert "grade" not in r.json()["data"]["properties"]  # 교체(replace)
    finally:
        # teardown: 엔티티 → 축(값 있으면 삭제 거부되므로 엔티티 먼저)
        for eid in ent_ids:
            c.delete(f"/api/entities/{eid}", headers=_h())
        if type_id is not None:
            # 속성 정의는 축 삭제 전 정리(FK 없지만 깔끔히)
            r = c.get(f"/api/entity-types/{type_id}/properties", headers=_h())
            if r.status_code == 200:
                for d in r.json()["data"]["items"]:
                    c.delete(f"/api/entity-types/{type_id}/properties/{d['id']}", headers=_h())
            c.delete(f"/api/entity-types/{type_id}", headers=_h())
