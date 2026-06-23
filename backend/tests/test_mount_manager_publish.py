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
from app.modules.grants import services as gs
from app.modules.grants.models import BoardGrant, GrantLevel, GrantPrincipalType
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


def test_board_edit_grant_opens_mount_target_for_nonmember():
    """게시판에 편집 권한(board edit grant)이 열려 있으면, 그 게시판의 멤버가
    아니어도 게시할 수 있다.

    트리: ... → dev-hw → dev-he. dev-he 매니저는 *상위* 게시판 dev-hw 의
    멤버가 아니므로 멤버십만으론 dev-hw 에 게시 못 한다(상위로는 못 올라감).
    하지만 dev-hw 가 dev-he 부서에 edit 권한을 열어두면 게시 가능해야 한다.
    """
    client = TestClient(app)
    # 행위자: dev-he 매니저(= 소스 권한). dev-hw 의 멤버는 아님.
    mgr = _ensure_member("grant-spread-mgr@test.local", BOARD2, Role.manager)
    rid = _make_report()
    db = SessionLocal()
    db.query(BoardGrant).filter_by(board_slug=BOARD1).delete()
    db.commit()
    try:
        # 작성자가 dev-he(BOARD2)에 최초 게시 → 행위자가 그 게시판 매니저라
        # 소스 권한(_ensure_can_mount)은 충족.
        assert (
            client.post(
                "/api/mounts",
                headers=_author_h(),
                json={"report_id": rid, "workspace_slugs": [BOARD2]},
            ).status_code
            == 200
        )
        # 편집 권한 개방 전 — 상위 게시판 dev-hw(BOARD1) 게시는 거절(멤버 아님).
        r = client.post(
            "/api/mounts",
            headers=_h(mgr, BOARD2),
            json={"report_id": rid, "workspace_slugs": [BOARD1]},
        )
        assert r.status_code == 403, r.text
        # dev-hw 가 dev-he 부서에 edit 권한 개방.
        gs.upsert_board_grant(
            db, BOARD1, GrantPrincipalType.workspace, BOARD2, GrantLevel.edit
        )
        db.commit()
        # 개방 후 — 같은 게시 요청이 허용.
        r2 = client.post(
            "/api/mounts",
            headers=_h(mgr, BOARD2),
            json={"report_id": rid, "workspace_slugs": [BOARD1]},
        )
        assert r2.status_code == 200, r2.text
    finally:
        db.query(BoardGrant).filter_by(board_slug=BOARD1).delete()
        db.commit()
        db.close()
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
