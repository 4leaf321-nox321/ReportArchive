"""온톨로지 강화 A0.3 스텝2 — object_links (cross-kind: 과제 → 부서) + ObjectRef.

과제(record) 엔티티를 실제 부서(workspace)에 owned_by 로 잇고, ObjectRef 해석·축
제약·중복·프로필 반영·삭제를 확인한다. dept 축·owned_by 관계는 마이그 p67 시드.
통합 테스트라 격리 없는 dev DB 에 붙는다.
"""
from __future__ import annotations

import uuid

import sqlalchemy as sa
from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token

ADMIN = 2


def _h(uid=ADMIN):
    return {"Authorization": f"Bearer {create_access_token(uid)}"}


def _an_org_workspace():
    db = SessionLocal()
    try:
        row = db.execute(
            sa.text("SELECT slug, name FROM workspaces WHERE kind='org' LIMIT 1")
        ).first()
        return (row.slug, row.name) if row else (None, None)
    finally:
        db.close()


def _type_id(c, slug):
    return next(
        t["id"] for t in c.get("/api/entity-types", headers=_h()).json()["data"]["items"]
        if t["slug"] == slug
    )


def test_object_links_dept_and_objectref():
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    dept_slug, dept_name = _an_org_workspace()
    assert dept_slug, "org 워크스페이스가 없어 테스트 스킵 불가"
    axis_slug = "tstol_" + sfx  # 잘못된 src 축 테스트용 일회용 축
    proj_id = None
    other_id = None
    other_type_id = None
    link_id = None
    try:
        proj_type_id = _type_id(c, "project")
        # 과제 하나 생성
        r = c.post("/api/entities", headers=_h(),
                   json={"type_id": proj_type_id, "value": "K-" + sfx})
        assert r.status_code in (200, 201), r.text
        proj_id = r.json()["data"]["id"]

        # 1. ObjectRef 해석 — dept(부서)
        r = c.get(f"/api/objects/dept/{dept_slug}", headers=_h())
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["type"] == "dept" and d["kind_class"] == "system"
        assert d["label"] == dept_name and d["url"] == f"/w/{dept_slug}"
        # 없는 부서 → 404
        assert c.get("/api/objects/dept/no_such_ws", headers=_h()).status_code == 404
        # entity 해석도 됨
        r = c.get(f"/api/objects/project/{proj_id}", headers=_h())
        assert r.status_code == 200 and r.json()["data"]["url"] == f"/entities/{proj_id}"
        # 비로그인 → 401
        assert c.get(f"/api/objects/dept/{dept_slug}").status_code == 401

        # 2. 과제 → 부서 링크(owned_by)
        r = c.post(f"/api/entities/{proj_id}/object-links", headers=_h(),
                   json={"dst_type": "dept", "dst_id": dept_slug, "relation": "owned_by"})
        assert r.status_code in (200, 201), r.text
        item = r.json()["data"]
        link_id = item["link_id"]
        assert item["target"]["label"] == dept_name
        assert item["direction"] == "out"

        # 3. 축 제약 — dst 가 dept 가 아니면 400
        r = c.post(f"/api/entities/{proj_id}/object-links", headers=_h(),
                   json={"dst_type": "model", "dst_id": "x", "relation": "owned_by"})
        assert r.status_code == 400, r.text
        # 축 제약 — src 가 project 가 아니면 400 (일회용 축 엔티티로)
        r = c.post("/api/entity-types", headers=_h(),
                   json={"slug": axis_slug, "label": "임시축"})
        other_type_id = r.json()["data"]["id"]
        r = c.post("/api/entities", headers=_h(),
                   json={"type_id": other_type_id, "value": "X-" + sfx})
        other_id = r.json()["data"]["id"]
        r = c.post(f"/api/entities/{other_id}/object-links", headers=_h(),
                   json={"dst_type": "dept", "dst_id": dept_slug, "relation": "owned_by"})
        assert r.status_code == 400, r.text

        # 4. 멱등 재-add → 같은 링크
        r = c.post(f"/api/entities/{proj_id}/object-links", headers=_h(),
                   json={"dst_type": "dept", "dst_id": dept_slug, "relation": "owned_by"})
        assert r.status_code in (200, 201) and r.json()["data"]["link_id"] == link_id

        # 5. 프로필의 system_links 반영
        r = c.get(f"/api/entities/{proj_id}/profile", headers=_h())
        assert r.status_code == 200, r.text
        sys_links = r.json()["data"]["system_links"]
        assert any(
            sl["link_id"] == link_id and sl["target"]["id"] == dept_slug
            for sl in sys_links
        ), sys_links

        # 5b. (A2) 부서 역방향 — /objects/dept/{slug}/links 에 담당 과제가 incoming
        r = c.get(f"/api/objects/dept/{dept_slug}/links", headers=_h())
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["object"]["label"] == dept_name
        assert any(
            it["direction"] == "in" and it["target"]["id"] == str(proj_id)
            for it in d["items"]
        ), d["items"]

        # 5c. (A1) 엔티티 그래프에 부서 system 노드 + 엣지
        g = c.get(f"/api/entities/{proj_id}/graph", headers=_h()).json()["data"]
        assert any(
            n.get("kind") == "system" and n.get("ref_id") == dept_slug
            for n in g["nodes"]
        ), g["nodes"]
        assert any(
            str(e["dst"]) == f"dept:{dept_slug}" for e in g["edges"]
        ), g["edges"]

        # 6. 삭제
        r = c.delete(f"/api/entities/{proj_id}/object-links/{link_id}", headers=_h())
        assert r.status_code == 200, r.text
        r = c.get(f"/api/entities/{proj_id}/object-links", headers=_h())
        assert all(sl["link_id"] != link_id for sl in r.json()["data"]["items"])
        link_id = None
    finally:
        if link_id is not None:
            c.delete(f"/api/entities/{proj_id}/object-links/{link_id}", headers=_h())
        for eid in (proj_id, other_id):
            if eid is not None:
                c.delete(f"/api/entities/{eid}", headers=_h())
        if other_type_id is not None:
            c.delete(f"/api/entity-types/{other_type_id}", headers=_h())
