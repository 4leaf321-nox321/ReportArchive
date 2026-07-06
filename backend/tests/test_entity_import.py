"""엔티티 벌크 임포트 (데이터 채우기 v1) — 파싱 + 미리보기(dry_run) + 커밋.

한 시트로 record 축 객체(값+속성)와 관계열까지 시딩되는지 확인한다:
  - 정상 행 → 생성, 속성 저장, 관계열 대상 resolve → 링크.
  - 속성 형식 오류 행 → error(전체 안 막힘).
  - 관계 대상 못 찾음 → 객체는 생성, 링크만 건너뜀(link_unresolved).
  - dry_run 은 쓰기 없음(미리보기).
mock 무관 — 서비스/라우트 직접. 끝나면 정리.
"""
from __future__ import annotations

import json
import uuid

from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token

ADMIN = {
    "Authorization": f"Bearer {create_access_token(2)}",
    "X-Workspace-Slug": "dx",
}


def _find(c, type_id, q):
    r = c.post("/api/entities/search", headers=ADMIN,
               json={"type_id": type_id, "q": q})
    return r.json()["data"]["items"]


def test_bulk_import_objects_props_relations():
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    proj_id = sup_id = None
    rel = "imprel_" + sfx
    rel_created = False
    made = []  # 생성된 project entity id
    try:
        # 축: project(record, budget number) + supplier(record) + 관계타입.
        proj_id = c.post("/api/entity-types", headers=ADMIN,
                         json={"slug": "impproj_" + sfx, "label": "임포트과제",
                               "kind_class": "record"}).json()["data"]["id"]
        c.post(f"/api/entity-types/{proj_id}/properties", headers=ADMIN,
               json={"key": "budget", "label": "예산", "data_type": "number"})
        sup_id = c.post("/api/entity-types", headers=ADMIN,
                        json={"slug": "impsup_" + sfx, "label": "임포트공급사",
                              "kind_class": "record"}).json()["data"]["id"]
        c.post("/api/relation-types", headers=ADMIN,
               json={"slug": rel, "label": "임포트관계", "directed": True})
        rel_created = True
        # 관계 대상 공급사 1건 존재.
        sup_val = "SUP1-" + sfx
        c.post("/api/entities", headers=ADMIN,
               json={"type_id": sup_id, "value": sup_val})

        a, b, cc = ("과제A-" + sfx, "과제B-" + sfx, "과제C-" + sfx)
        csv = (
            "이름,예산,공급사\n"
            f"{a},5,{sup_val}\n"          # 정상 + 링크 resolve
            f"{b},notanumber,{sup_val}\n"  # 속성 오류 → error
            f"{cc},7,MISSING-{sfx}\n"      # 공급사 못 찾음 → 링크 건너뜀
        ).encode("utf-8")
        mapping = {
            "type_id": proj_id,
            "value_column": "이름",
            "property_columns": {"예산": "budget"},
            "relation_columns": [
                {"column": "공급사", "relation": rel, "target_type": "impsup_" + sfx}
            ],
        }

        # inspect — 헤더 확인.
        r = c.post("/api/entities/import/inspect", headers=ADMIN,
                   files={"file": ("proj.csv", csv, "text/csv")})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["columns"] == ["이름", "예산", "공급사"]
        assert r.json()["data"]["row_count"] == 3

        # 미리보기(dry_run) — 쓰기 없음.
        r = c.post("/api/entities/import", headers=ADMIN,
                   files={"file": ("proj.csv", csv, "text/csv")},
                   data={"mapping": json.dumps({**mapping, "dry_run": True})})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["summary"]["committed"] is False
        assert d["summary"]["create"] == 2 and d["summary"]["error"] == 1
        assert _find(c, proj_id, a) == []  # 아직 안 생김

        # 커밋.
        r = c.post("/api/entities/import", headers=ADMIN,
                   files={"file": ("proj.csv", csv, "text/csv")},
                   data={"mapping": json.dumps({**mapping, "dry_run": False})})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["summary"]["committed"] is True
        assert d["summary"]["create"] == 2, d["summary"]
        assert d["summary"]["linked"] == 1, d["summary"]         # A→SUP1
        assert d["summary"]["link_unresolved"] == 1, d["summary"]  # C→MISSING

        # A 생성 + 관계 확인.
        items = _find(c, proj_id, a)
        assert len(items) == 1, items
        made = [i["id"] for i in _find(c, proj_id, "과제")]
        aid = items[0]["id"]
        rr = c.get(f"/api/entities/{aid}/relations", headers=ADMIN).json()["data"]
        assert any(p["relation"] == rel for p in rr["parents"]), rr
    finally:
        for eid in made:
            rr = c.get(f"/api/entities/{eid}/relations", headers=ADMIN)
            if rr.status_code == 200:
                for p in rr.json()["data"]["parents"]:
                    c.delete(f"/api/entities/{eid}/relations/{p['relation_id']}",
                             headers=ADMIN)
            c.delete(f"/api/entities/{eid}", headers=ADMIN)
        for it in _find(c, sup_id, "SUP1-" + sfx) if sup_id else []:
            c.delete(f"/api/entities/{it['id']}", headers=ADMIN)
        if rel_created:
            c.delete(f"/api/relation-types/{rel}", headers=ADMIN)
        if proj_id:
            rp = c.get(f"/api/entity-types/{proj_id}/properties", headers=ADMIN)
            if rp.status_code == 200:
                for pd in rp.json()["data"]["items"]:
                    c.delete(f"/api/entity-types/{proj_id}/properties/{pd['id']}",
                             headers=ADMIN)
            c.delete(f"/api/entity-types/{proj_id}", headers=ADMIN)
        if sup_id:
            c.delete(f"/api/entity-types/{sup_id}", headers=ADMIN)
