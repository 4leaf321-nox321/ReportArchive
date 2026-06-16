"""비멤버 grant 브라우징 — 게시판/폴더 단위 공유 수신자(하위부서 포함)는 그 게시판을
브라우즈할 수 있어야 하지만, 게시(mount) 가 자동 만드는 부서 grant 만으로는 비멤버가
상위 게시판 게시글을 통째로 보면 안 된다(누수 방지).

버그1(원래): 그룹 게시판에 18 게시 + 그룹(하위 포함) 조회권한(=게시판 공유) → 하위
'파트' 부서가 3건(전체공개)만 봄. → 게시판 공유 수신자가 브라우즈 가능해야 함.
버그2(회귀): 게시판을 공유 안 했는데도 하위 계정이 상위 게시판 보고서를 전부 봄. →
게시 자동 grant(workspace=게시판)는 비멤버 가시성에서 제외해야 함.

트리: dx → division-mx → dev → dev-hw   (dev-hw 는 dev 의 하위)
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.grants import services as gs
from app.modules.grants.models import (
    BoardGrant,
    ContentGrant,
    GrantContentType,
    GrantLevel,
    GrantPrincipalType,
)
from app.modules.users.models import Role, User, WorkspaceMember

CT = GrantContentType.report
CONTENT_ID = 999_500_001
GROUP_WS = "dev"       # 보고서가 게시될 그룹 게시판
PART_WS = "dev-hw"     # dev 의 하위(파트) 부서


class _WS:
    def __init__(self, slug, virtual=False):
        self.slug = slug
        self.virtual = virtual


class _U:
    def __init__(self, uid, is_system_admin=False):
        self.id = uid
        self.is_system_admin = is_system_admin


class _Actor:
    """X-Workspace-Slug 로 GROUP_WS 를 active 로 둔 비멤버(public_viewer)."""

    def __init__(self, uid, slug=GROUP_WS, public_viewer=True):
        self.user = _U(uid)
        self.workspace = _WS(slug)
        self.public_viewer = public_viewer


def _ensure_user(email, ws) -> int:
    db = SessionLocal()
    try:
        u = db.query(User).filter_by(email=email).one_or_none()
        if u is None:
            u = User(email=email, name=email, password_hash="!unused-tests-only")
            db.add(u)
            db.flush()
        if ws is not None:
            m = (
                db.query(WorkspaceMember)
                .filter_by(user_id=u.id, workspace_slug=ws)
                .one_or_none()
            )
            if m is None:
                db.add(WorkspaceMember(user_id=u.id, workspace_slug=ws, role=Role.user))
        db.commit()
        return u.id
    finally:
        db.close()


def _clear(db):
    db.query(ContentGrant).filter_by(content_type=CT, content_id=CONTENT_ID).delete()
    db.query(BoardGrant).filter_by(board_slug=GROUP_WS).delete()
    db.commit()


def test_mount_grant_alone_does_not_leak_to_nonmember():
    """게시(mount) 자동 grant(workspace=게시판)만 있고 게시판 공유는 없을 때,
    하위부서(dev-hw) 비멤버는 그 콘텐츠를 보면 안 된다(버그2 회귀 가드)."""
    db = SessionLocal()
    try:
        part_uid = _ensure_user("leak-part@test.local", PART_WS)
        _clear(db)
        # 게시가 만드는 것과 동일한 workspace(dev) view content grant(= mount 자동 grant).
        gs.upsert_grant(
            db, CT, CONTENT_ID, GrantPrincipalType.workspace, GROUP_WS, GrantLevel.view
        )
        db.commit()

        part = _Actor(part_uid)
        # 비멤버는 mount 자동 grant 로는 못 본다(명시 공유 아님).
        assert not gs.can_view(db, part, CT, CONTENT_ID, None)
        assert CONTENT_ID not in gs.visible_ids(db, part, CT)
        assert CONTENT_ID not in gs.visible_ids_for_user(db, part_uid, CT)
    finally:
        _clear(db)
        db.close()


def test_board_grant_admits_subdept_browse_but_not_outsider():
    """게시판/부서 단위 공유가 있어야 비멤버가 그 게시판을 *브라우즈* 진입.
    하위부서 멤버는 진입 허용, 무소속 외부인은 불가(버그1 수정)."""
    db = SessionLocal()
    try:
        part_uid = _ensure_user("entry-part@test.local", PART_WS)
        outsider_uid = _ensure_user("entry-out@test.local", None)
        db.query(BoardGrant).filter_by(board_slug=GROUP_WS).delete()
        db.commit()

        assert not gs.user_has_container_grant_on_board(db, part_uid, GROUP_WS)
        assert not gs.user_has_container_grant_on_board(db, outsider_uid, GROUP_WS)

        gs.upsert_board_grant(
            db, GROUP_WS, GrantPrincipalType.workspace, GROUP_WS, GrantLevel.view
        )
        db.commit()

        assert gs.user_has_container_grant_on_board(db, part_uid, GROUP_WS)
        assert not gs.user_has_container_grant_on_board(db, outsider_uid, GROUP_WS)
    finally:
        db.query(BoardGrant).filter_by(board_slug=GROUP_WS).delete()
        db.commit()
        db.close()


def test_e2e_board_share_lets_subdept_browse_list():
    """e2e: dev 게시판에 보고서 게시 → 하위 dev-hw 계정은 (공유 전) 못 보고,
    dev 게시판을 dev 부서(하위 포함)에 공유하면 목록에 뜬다."""
    client = TestClient(app)
    part = _ensure_user("e2e-part@test.local", PART_WS)

    def admin_h(ws):
        return {
            "Authorization": f"Bearer {create_access_token(1)}",
            "X-Workspace-Slug": ws,
        }

    part_h = {
        "Authorization": f"Bearer {create_access_token(part)}",
        "X-Workspace-Slug": GROUP_WS,
    }

    tpl = client.get("/api/templates", headers=admin_h(GROUP_WS)).json()["data"][0]
    rid = client.post(
        "/api/reports",
        headers=admin_h(GROUP_WS),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "비멤버 브라우즈 e2e",
            "tags": [],
        },
    ).json()["data"]["id"]
    client.post(
        "/api/mounts",
        headers=admin_h(GROUP_WS),
        json={"report_id": rid, "workspace_slugs": [GROUP_WS]},
    )
    db = SessionLocal()
    db.query(BoardGrant).filter_by(board_slug=GROUP_WS).delete()
    db.commit()
    db.close()
    try:
        # 공유 전 — 게시 자동 grant 만으론 하위 비멤버에게 안 보인다(403 또는 미포함).
        before = client.get("/api/reports", headers=part_h)
        before_ids = (
            [r["id"] for r in before.json().get("data", [])]
            if before.status_code == 200
            else []
        )
        assert rid not in before_ids

        # dev 게시판을 dev 부서(하위 상속)에 view 공유.
        shared = client.post(
            f"/api/workspaces/{GROUP_WS}/shares",
            headers=admin_h(GROUP_WS),
            json={
                "principal_type": "workspace",
                "principal_ref": GROUP_WS,
                "level": "view",
            },
        )
        assert shared.status_code == 201, shared.text

        # 공유 후 — 하위 dev-hw 계정 목록에 뜬다.
        after = client.get("/api/reports", headers=part_h)
        assert after.status_code == 200, after.text
        assert rid in [r["id"] for r in after.json()["data"]]
    finally:
        lst = client.get(f"/api/workspaces/{GROUP_WS}/shares", headers=admin_h(GROUP_WS))
        if lst.status_code == 200:
            for g in lst.json()["data"]:
                client.delete(
                    f"/api/workspaces/{GROUP_WS}/shares/{g['id']}",
                    headers=admin_h(GROUP_WS),
                )
        client.delete(f"/api/reports/{rid}", headers=admin_h(GROUP_WS))
