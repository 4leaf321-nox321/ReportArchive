"""system 객체 확장 — user/report 투영 + report 가시성 게이트 + FK 파생 관계.

가장 중요한 건 **보고서 가시성 유출 방지**: resolve_object(report)·derived 가 요청자가
볼 수 있는 보고서만 노출하고, actor 없음/권한 밖이면 존재 자체를 감춘다.
"""
from __future__ import annotations

from sqlalchemy import select

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.entities import services as ent
from app.modules.reports import services as rep_services
from app.modules.reports.models import Report
from app.modules.users.models import User

ADMIN = {
    "Authorization": f"Bearer {create_access_token(2)}",
    "X-Workspace-Slug": "dx",
}


def _some_report(db):
    """user 2 가 실제로 볼 수 있는 보고서 하나(가시성 게이트가 통과할 것)."""
    for rid in rep_services.all_visible_report_ids(db, 2):
        r = db.get(Report, rid)
        if r is not None and r.deleted_at is None:
            return r
    return None


def test_resolve_user_and_report_visibility_gate(monkeypatch):
    db = SessionLocal()
    try:
        r = _some_report(db)
        if r is None:
            return  # 보고서가 없으면 스킵(dev DB엔 있음)
        actor = db.get(User, 2)  # 시스템 관리자 — 전체 가시

        # user 해석 — 라벨=이름만, email 비노출.
        if r.owner_user_id:
            uref = ent.resolve_object(db, "user", str(r.owner_user_id), actor)
            assert uref and uref["type"] == "user" and uref["label"]
            assert "email" not in uref
            assert uref["url"] == f"/objects/user/{r.owner_user_id}"

        # report 해석 — admin 가시.
        rref = ent.resolve_object(db, "report", str(r.id), actor)
        assert rref and rref["label"] == r.title
        assert rref["url"] == f"/reports/{r.id}"

        # ★ 게이트 ① actor 없음 → None(유출 방지 기본값).
        assert ent.resolve_object(db, "report", str(r.id), None) is None

        # ★ 게이트 ② 안 보이는 보고서면 admin 이어도 None.
        monkeypatch.setattr(rep_services, "all_visible_report_ids", lambda db, uid: set())
        assert ent.resolve_object(db, "report", str(r.id), actor) is None
    finally:
        db.close()


def test_derived_links_report(monkeypatch):
    db = SessionLocal()
    try:
        r = _some_report(db)
        if r is None:
            return
        actor = db.get(User, 2)
        d = ent.derived_links_for(db, actor, "report", str(r.id))
        rels = {x["relation"] for x in d}
        # 작성자·게시부서는 FK 로 항상 파생(있으면).
        if r.owner_user_id:
            assert "authored_by" in rels, d
        if r.workspace_slug:
            assert "published_in" in rels, d
        # 각 항목은 해석된 object 를 가진다.
        assert all(x["object"] and x["object"].get("type") for x in d)

        # ★ 안 보이면 파생도 비어야(유출 방지).
        monkeypatch.setattr(rep_services, "all_visible_report_ids", lambda db, uid: set())
        assert ent.derived_links_for(db, actor, "report", str(r.id)) == []
    finally:
        db.close()


def test_objects_route_user_and_report():
    c = TestClient(app)
    db = SessionLocal()
    try:
        r = _some_report(db)
        owner = r.owner_user_id if r else None
    finally:
        db.close()
    if r is None:
        return
    # 라우트로 user/report 해석 (admin).
    if owner:
        ru = c.get(f"/api/objects/user/{owner}", headers=ADMIN)
        assert ru.status_code == 200, ru.text
        assert ru.json()["data"]["type"] == "user"
    rr = c.get(f"/api/objects/report/{r.id}/links", headers=ADMIN)
    assert rr.status_code == 200, rr.text
    data = rr.json()["data"]
    assert data["object"]["type"] == "report"
    assert "derived" in data  # 파생 관계 포함
