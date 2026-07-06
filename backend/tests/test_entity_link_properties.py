"""온톨로지 강화 A0.2 스텝1 — 링크 속성/근거 (relation_type property_defs).

일회용 축·관계종류를 만들어 관계에 속성 스키마를 붙이고, 링크 저장 시 관계종류
스키마로 검증되는지 + 근거(evidence) 저장/검증을 확인한다. 끝나면 관계→정의→
관계종류→엔티티→축 순으로 정리한다. 전부 additive라 기존 part_of 동작 무영향.
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token

ADMIN = 2  # is_system_admin


def _h(uid=ADMIN):
    return {"Authorization": f"Bearer {create_access_token(uid)}"}


def test_link_properties_and_evidence():
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    axis_slug = "tst_" + sfx
    rel_slug = "tstrel_" + sfx
    type_id = None
    rel_created = False
    ent_ids = []
    rel_id = None
    try:
        # 1. 일회용 축 + 엔티티 2개
        r = c.post("/api/entity-types", headers=_h(), json={"slug": axis_slug, "label": "테스트축"})
        assert r.status_code in (200, 201), r.text
        type_id = r.json()["data"]["id"]
        for v in ("A-" + sfx, "B-" + sfx):
            r = c.post("/api/entities", headers=_h(), json={"type_id": type_id, "value": v})
            assert r.status_code in (200, 201), r.text
            ent_ids.append(r.json()["data"]["id"])
        src_id, dst_id = ent_ids

        # 2. 일회용 관계종류(축 제약 없음)
        r = c.post("/api/relation-types", headers=_h(), json={
            "slug": rel_slug, "label": "테스트관계", "directed": True,
        })
        assert r.status_code in (200, 201), r.text
        rel_created = True

        # 3. 관계종류에 링크 속성 정의: result(enum, 필수) + qty(number)
        for body in (
            {"key": "result", "label": "결과", "data_type": "enum", "required": True,
             "enum_options": [{"value": "pass", "label": "합격"}, {"value": "fail", "label": "불합격"}]},
            {"key": "qty", "label": "수량", "data_type": "number", "unit": "ea"},
        ):
            r = c.post(f"/api/relation-types/{rel_slug}/properties", headers=_h(), json=body)
            assert r.status_code in (200, 201), r.text
        # 잘못된 data_type → 400
        r = c.post(f"/api/relation-types/{rel_slug}/properties", headers=_h(),
                   json={"key": "bad", "label": "x", "data_type": "nope"})
        assert r.status_code == 400, r.text
        # 목록 2개(인증만)
        r = c.get(f"/api/relation-types/{rel_slug}/properties", headers=_h())
        assert r.status_code == 200 and len(r.json()["data"]["items"]) == 2

        # 4. 유효한 속성 + 근거메모로 링크 추가
        r = c.post(f"/api/entities/{src_id}/relations", headers=_h(), json={
            "dst_entity_id": dst_id, "relation": rel_slug,
            "properties": {"result": "pass", "qty": 3},
            "evidence_note": "2026 시험보고서 3.2절",
        })
        assert r.status_code in (200, 201), r.text
        data = r.json()["data"]
        rel_id = data["relation_id"]
        assert data["properties"]["result"] == "pass"
        assert data["properties"]["qty"] == 3
        assert data["evidence_note"] == "2026 시험보고서 3.2절"

        # 5. 검증 실패들 → 400 (자기참조 아닌 새 dst 는 없으니 기존 링크로 검증)
        base = {"dst_entity_id": dst_id, "relation": rel_slug}
        # 필수(result) 누락
        r = c.post(f"/api/entities/{src_id}/relations", headers=_h(),
                   json={**base, "properties": {"qty": 1}})
        assert r.status_code == 400, r.text
        # enum 잘못된 값
        r = c.post(f"/api/entities/{src_id}/relations", headers=_h(),
                   json={**base, "properties": {"result": "maybe"}})
        assert r.status_code == 400, r.text
        # 미정의 키
        r = c.post(f"/api/entities/{src_id}/relations", headers=_h(),
                   json={**base, "properties": {"result": "pass", "ghost": 1}})
        assert r.status_code == 400, r.text
        # 근거 보고서 없음 → 400
        r = c.post(f"/api/entities/{src_id}/relations", headers=_h(),
                   json={**base, "properties": {"result": "pass"}, "evidence_report_id": 999999999})
        assert r.status_code == 400, r.text

        # 6. PATCH 로 속성 교체(검증됨) + 근거메모 수정
        r = c.patch(f"/api/entities/{src_id}/relations/{rel_id}", headers=_h(),
                    json={"properties": {"result": "fail"}, "evidence_note": "재시험"})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["properties"]["result"] == "fail"
        assert "qty" not in d["properties"]  # 교체(replace)
        assert d["evidence_note"] == "재시험"
        # PATCH 검증도 걸림 — 필수 누락
        r = c.patch(f"/api/entities/{src_id}/relations/{rel_id}", headers=_h(),
                    json={"properties": {"qty": 5}})
        assert r.status_code == 400, r.text

        # 7. 목록이 속성/근거 반영
        r = c.get(f"/api/entities/{src_id}/relations", headers=_h())
        assert r.status_code == 200
        parents = r.json()["data"]["parents"]
        mine = [p for p in parents if p["relation_id"] == rel_id]
        assert len(mine) == 1
        assert mine[0]["properties"]["result"] == "fail"
        assert mine[0]["evidence_note"] == "재시험"

        # 8. 멱등 재-add 가 속성 갱신
        r = c.post(f"/api/entities/{src_id}/relations", headers=_h(), json={
            "dst_entity_id": dst_id, "relation": rel_slug,
            "properties": {"result": "pass", "qty": 7},
        })
        assert r.status_code in (200, 201), r.text
        assert r.json()["data"]["relation_id"] == rel_id  # 같은 링크
        assert r.json()["data"]["properties"]["qty"] == 7
    finally:
        if rel_id is not None:
            c.delete(f"/api/entities/{ent_ids[0]}/relations/{rel_id}", headers=_h())
        if rel_created:
            rp = c.get(f"/api/relation-types/{rel_slug}/properties", headers=_h())
            if rp.status_code == 200:
                for d in rp.json()["data"]["items"]:
                    c.delete(f"/api/relation-types/{rel_slug}/properties/{d['id']}", headers=_h())
            c.delete(f"/api/relation-types/{rel_slug}", headers=_h())
        for eid in ent_ids:
            c.delete(f"/api/entities/{eid}", headers=_h())
        if type_id is not None:
            c.delete(f"/api/entity-types/{type_id}", headers=_h())
