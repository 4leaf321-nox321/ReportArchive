"""게시(mount) 권한 확장 — 이미 게시된 게시판의 매니저는 그 문서를 다른
게시판에도 게시할 수 있다(협업개선 Phase 3 흐름).

규칙: A 게시판에 올라간 문서를, A 게시판 매니저가 B 게시판으로 확산.
- 작성자(user 1)가 BOARD1 에 게시.
- BOARD1 의 매니저(작성자 아님)가 BOARD2 로 게시 → 성공.
- 권한 없는 사용자(어느 게시 게시판의 매니저도 아님)는 거절.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.users.models import Role, User, WorkspaceMember

BOARD1 = "dev-hw"  # 작성자가 처음 게시하는 게시판
BOARD2 = "dev-he"  # 매니저가 확산하려는 다른 게시판(dev-hw 의 하위 — 매니저가
                   # 상속으로 대상 접근권을 가짐)


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


def _author_h():
    # user 1 = 작성자 (dx 활성)
    return {"Authorization": f"Bearer {create_access_token(1)}", "X-Workspace-Slug": "dx"}


def _h(uid, slug):
    return {"Authorization": f"Bearer {create_access_token(uid)}", "X-Workspace-Slug": slug}


def _make_report():
    client = TestClient(app)
    tpl = client.get("/api/templates", headers=_author_h()).json()["data"][0]
    return client.post(
        "/api/reports",
        headers=_author_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "매니저 확산 게시 테스트",
            "tags": [],
        },
    ).json()["data"]["id"]


def test_manager_of_mounted_board_can_mount_elsewhere():
    client = TestClient(app)
    # BOARD1 매니저 + BOARD2 멤버(대상 접근권). 작성자는 아님.
    mgr = _ensure_member("spread-mgr@test.local", BOARD1, Role.manager)
    _ensure_member("spread-mgr@test.local", BOARD2, Role.user)
    rid = _make_report()
    try:
        # 작성자가 BOARD1 에 최초 게시.
        assert (
            client.post(
                "/api/mounts",
                headers=_author_h(),
                json={"report_id": rid, "workspace_slugs": [BOARD1]},
            ).status_code
            == 200
        )
        # BOARD1 매니저(작성자 아님)가 BOARD2 로 확산 → 허용.
        r = client.post(
            "/api/mounts",
            headers=_h(mgr, BOARD2),
            json={"report_id": rid, "workspace_slugs": [BOARD2]},
        )
        assert r.status_code == 200, r.text
        slugs = {
            s["principal_ref"]
            for s in client.get(f"/api/reports/{rid}/shares", headers=_author_h())
            .json()["data"]
            if s["principal_type"] == "workspace"
        }
        assert {BOARD1, BOARD2} <= slugs, slugs
    finally:
        client.delete(f"/api/reports/{rid}", headers=_author_h())


def test_non_manager_cannot_mount_others_report():
    client = TestClient(app)
    # BOARD1·BOARD2 의 일반 멤버일 뿐, 어디서도 매니저가 아님.
    uid = _ensure_member("spread-nonmgr@test.local", BOARD1, Role.user)
    _ensure_member("spread-nonmgr@test.local", BOARD2, Role.user)
    rid = _make_report()
    try:
        client.post(
            "/api/mounts",
            headers=_author_h(),
            json={"report_id": rid, "workspace_slugs": [BOARD1]},
        )
        # 작성자도 아니고 매니저도 아님 → 403.
        r = client.post(
            "/api/mounts",
            headers=_h(uid, BOARD2),
            json={"report_id": rid, "workspace_slugs": [BOARD2]},
        )
        assert r.status_code == 403, r.text
    finally:
        client.delete(f"/api/reports/{rid}", headers=_author_h())
