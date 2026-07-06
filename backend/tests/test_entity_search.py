"""객체 중심 검색 (Phase C) — POST /api/entities/search.

일회용 record 축(속성 enum/number/date)에 엔티티 몇 개를 만들어 속성 필터(eq·gte·
between·date range)·이름 검색·관계 필터·정렬/페이지를 확인한다. 끝나면 정리.
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token

ADMIN = 2


def _h(uid=ADMIN):
    return {"Authorization": f"Bearer {create_access_token(uid)}"}


def _search(c, body):
    r = c.post("/api/entities/search", headers=_h(), json=body)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    return {e["value"] for e in d["items"]}, d["total"]


def test_object_search():
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    axis = "tsts_" + sfx
    rel = "tstsrel_" + sfx
    type_id = None
    rel_created = False
    ids = {}
    try:
        # 축 + 속성정의(grade enum, score number, day date)
        type_id = c.post("/api/entity-types", headers=_h(),
                         json={"slug": axis, "label": "검색축", "kind_class": "record"}
                         ).json()["data"]["id"]
        for body in (
            {"key": "grade", "label": "등급", "data_type": "enum",
             "enum_options": [{"value": "A", "label": "A"}, {"value": "B", "label": "B"}]},
            {"key": "score", "label": "점수", "data_type": "number"},
            {"key": "day", "label": "날짜", "data_type": "date"},
        ):
            c.post(f"/api/entity-types/{type_id}/properties", headers=_h(), json=body)

        # 엔티티 3개
        specs = {
            "E1-" + sfx: {"grade": "A", "score": "10", "day": "2025-01-01"},
            "E2-" + sfx: {"grade": "B", "score": "20", "day": "2025-06-01"},
            "E3-" + sfx: {"grade": "A", "score": "30", "day": "2025-12-01"},
        }
        for v, p in specs.items():
            ids[v] = c.post("/api/entities", headers=_h(),
                            json={"type_id": type_id, "value": v, "properties": p}
                            ).json()["data"]["id"]

        # 1. enum eq — grade=A → E1, E3
        vals, total = _search(c, {"type_id": type_id, "props": [{"key": "grade", "op": "eq", "value": "A"}]})
        assert vals == {"E1-" + sfx, "E3-" + sfx} and total == 2, (vals, total)

        # 2. number gte 20 → E2, E3
        vals, _ = _search(c, {"type_id": type_id, "props": [{"key": "score", "op": "gte", "value": 20}]})
        assert vals == {"E2-" + sfx, "E3-" + sfx}, vals

        # 3. number between [15,25] → E2
        vals, _ = _search(c, {"type_id": type_id, "props": [{"key": "score", "op": "between", "value": [15, 25]}]})
        assert vals == {"E2-" + sfx}, vals

        # 4. date gte 2025-06-01 → E2, E3
        vals, _ = _search(c, {"type_id": type_id, "props": [{"key": "day", "op": "gte", "value": "2025-06-01"}]})
        assert vals == {"E2-" + sfx, "E3-" + sfx}, vals

        # 5. 복합 — grade=A AND score gte 20 → E3
        vals, _ = _search(c, {"type_id": type_id, "props": [
            {"key": "grade", "op": "eq", "value": "A"},
            {"key": "score", "op": "gte", "value": 20}]})
        assert vals == {"E3-" + sfx}, vals

        # 6. 이름 검색 q → E1 만
        vals, _ = _search(c, {"type_id": type_id, "q": "E1-" + sfx})
        assert vals == {"E1-" + sfx}, vals

        # 7. 관계 필터 — E1 --rel--> E2, 그럼 relations=[{rel,dst=E2}] → E1
        c.post("/api/relation-types", headers=_h(),
               json={"slug": rel, "label": "검색관계", "directed": True})
        rel_created = True
        c.post(f"/api/entities/{ids['E1-'+sfx]}/relations", headers=_h(),
               json={"dst_entity_id": ids["E2-" + sfx], "relation": rel})
        vals, _ = _search(c, {"type_id": type_id, "relations": [
            {"relation": rel, "dst_id": ids["E2-" + sfx]}]})
        assert vals == {"E1-" + sfx}, vals

        # 8. 페이지 — limit 2 → total 3, items 2
        r = c.post("/api/entities/search", headers=_h(),
                   json={"type_id": type_id, "limit": 2}).json()["data"]
        assert r["total"] == 3 and len(r["items"]) == 2
    finally:
        for v, eid in ids.items():
            # 관계 먼저 정리
            rr = c.get(f"/api/entities/{eid}/relations", headers=_h())
            if rr.status_code == 200:
                for p in rr.json()["data"]["parents"]:
                    c.delete(f"/api/entities/{eid}/relations/{p['relation_id']}", headers=_h())
            c.delete(f"/api/entities/{eid}", headers=_h())
        if rel_created:
            c.delete(f"/api/relation-types/{rel}", headers=_h())
        if type_id is not None:
            rp = c.get(f"/api/entity-types/{type_id}/properties", headers=_h())
            if rp.status_code == 200:
                for d in rp.json()["data"]["items"]:
                    c.delete(f"/api/entity-types/{type_id}/properties/{d['id']}", headers=_h())
            c.delete(f"/api/entity-types/{type_id}", headers=_h())
