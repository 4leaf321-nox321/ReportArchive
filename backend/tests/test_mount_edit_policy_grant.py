"""게시(mount) 편집 정책이 grant 에 연결되는지 — 공유/권한 개편.

열람 전용(default/owner_only) → 그 게시판 부서 view grant,
공동 편집(coauthor) → 부서 edit grant. can_edit 는 grant 만 보므로 이게
실제 편집 권한을 좌우한다.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.grants import services as gs
from app.modules.grants.models import GrantContentType
from app.modules.users.models import Role, User, WorkspaceMember

BOARD = "dev-hw"


def _ensure_member(email, slug, role):
    db = SessionLocal()
    try:
        u = db.query(User).filter_by(email=email).one_or_none()
        if u is None:
            u = User(email=email, name=email, password_hash="!unused-tests-only")
            db.add(u)
            db.flush()
        m = (
            db.query(WorkspaceMember)
            .filter_by(user_id=u.id, workspace_slug=slug)
            .one_or_none()
        )
        if m is None:
            db.add(WorkspaceMember(user_id=u.id, workspace_slug=slug, role=role))
        else:
            m.role = role
        db.commit()
        return u.id
    finally:
        db.close()


def _h():
    return {"Authorization": f"Bearer {create_access_token(1)}", "X-Workspace-Slug": "dx"}


def test_mount_policy_drives_board_edit_grant():
    client = TestClient(app)
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    rid = client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "게시 편집정책 테스트",
            "tags": [],
        },
    ).json()["data"]["id"]
    assert (
        client.post(
            "/api/mounts",
            headers=_h(),
            json={"report_id": rid, "workspace_slugs": [BOARD]},
        ).status_code
        == 200
    )
    try:
        # 기본 게시 = 열람 → 그 게시판 부서 grant 는 view.
        shares = client.get(f"/api/reports/{rid}/shares", headers=_h()).json()["data"]
        g = next(
            (s for s in shares if s["principal_type"] == "workspace"), None
        )
        assert g is not None and g["level"] == "view", shares

        # 공동 편집으로 변경 → 부서 grant 가 edit 로.
        r = client.put(
            f"/api/mounts/{rid}/{BOARD}/edit-policy",
            headers=_h(),
            json={"edit_policy": "coauthor"},
        )
        assert r.status_code == 200, r.text
        shares = client.get(f"/api/reports/{rid}/shares", headers=_h()).json()["data"]
        g = next((s for s in shares if s["principal_type"] == "workspace"), None)
        assert g is not None and g["level"] == "edit", shares

        # 다시 열람 전용 → view 로 되돌림.
        client.put(
            f"/api/mounts/{rid}/{BOARD}/edit-policy",
            headers=_h(),
            json={"edit_policy": "default"},
        )
        shares = client.get(f"/api/reports/{rid}/shares", headers=_h()).json()["data"]
        g = next((s for s in shares if s["principal_type"] == "workspace"), None)
        assert g is not None and g["level"] == "view", shares
    finally:
        client.delete(f"/api/reports/{rid}", headers=_h())


def test_manager_policy_grants_board_manager_edit():
    """작성자+게시판 매니저 정책 → 부서 view + workspace_manager edit grant,
    그리고 그 게시판 매니저만 편집 도달(일반 멤버는 불가)."""
    client = TestClient(app)
    mgr = _ensure_member("mount-mgr@test.local", BOARD, Role.manager)
    member = _ensure_member("mount-member@test.local", BOARD, Role.user)
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    rid = client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "매니저 편집 정책 테스트",
            "tags": [],
        },
    ).json()["data"]["id"]
    client.post(
        "/api/mounts",
        headers=_h(),
        json={"report_id": rid, "workspace_slugs": [BOARD]},
    )
    try:
        r = client.put(
            f"/api/mounts/{rid}/{BOARD}/edit-policy",
            headers=_h(),
            json={"edit_policy": "manager"},
        )
        assert r.status_code == 200, r.text
        shares = client.get(f"/api/reports/{rid}/shares", headers=_h()).json()["data"]
        types = {(s["principal_type"], s["level"]) for s in shares}
        assert ("workspace", "view") in types, shares
        assert ("workspace_manager", "edit") in types, shares

        # 도달성: 게시판 매니저는 편집 가능, 일반 멤버는 불가.
        db = SessionLocal()
        try:
            assert gs._manager_edit_reaches(db, GrantContentType.report, rid, mgr)
            assert not gs._manager_edit_reaches(
                db, GrantContentType.report, rid, member
            )
        finally:
            db.close()
    finally:
        client.delete(f"/api/reports/{rid}", headers=_h())
