"""게시판(board) 통째 공유 — 도달성 단위 + all_org 비멤버 진입 e2e.

board grant 도 콘텐츠 grant 와 같은 하위 상속/상위 차단 규칙을 따른다.
트리: dx → division-mx → dev → dev-hw → ...
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.grants import services as gs
from app.modules.grants.models import BoardGrant, GrantLevel, GrantPrincipalType
from app.modules.users.models import Role, User, WorkspaceMember

BOARD = "dev-hw"      # 공유 대상이 될 게시판
PARENT_WS = "dx"      # 루트
CHILD_WS = "dev"      # dx 의 하위(그리고 dev-hw 의 상위)


class _WS:
    def __init__(self, slug, virtual=False):
        self.slug = slug
        self.virtual = virtual


class _U:
    def __init__(self, uid, is_system_admin=False):
        self.id = uid
        self.is_system_admin = is_system_admin


class _Actor:
    def __init__(self, uid, slug, public_viewer=False):
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


def _clear_board(db):
    db.query(BoardGrant).filter_by(board_slug=BOARD).delete()
    db.commit()


def test_board_view_reach_downward_and_no_upward():
    db = SessionLocal()
    try:
        parent_uid = _ensure_user("board-parent@test.local", PARENT_WS)
        child_uid = _ensure_user("board-child@test.local", CHILD_WS)
        _clear_board(db)

        # 게시판을 부모(dx)에 공유 → dx·하위(dev) 컨텍스트 모두 도달.
        gs.upsert_board_grant(
            db, BOARD, GrantPrincipalType.workspace, PARENT_WS, GrantLevel.view
        )
        db.commit()
        assert gs._board_view_reaches(db, [BOARD], _Actor(parent_uid, PARENT_WS), include_all_org=True)
        assert gs._board_view_reaches(db, [BOARD], _Actor(child_uid, CHILD_WS), include_all_org=True)

        # 게시판을 자식(dev)에만 공유 → dev 는 도달, 부모(dx) 컨텍스트는 도달 안 함.
        _clear_board(db)
        gs.upsert_board_grant(
            db, BOARD, GrantPrincipalType.workspace, CHILD_WS, GrantLevel.view
        )
        db.commit()
        assert gs._board_view_reaches(db, [BOARD], _Actor(child_uid, CHILD_WS), include_all_org=True)
        assert not gs._board_view_reaches(db, [BOARD], _Actor(parent_uid, PARENT_WS), include_all_org=True)
    finally:
        _clear_board(db)
        db.close()


def test_board_edit_reach_downward_only():
    db = SessionLocal()
    try:
        parent_uid = _ensure_user("board-parent@test.local", PARENT_WS)
        child_uid = _ensure_user("board-child@test.local", CHILD_WS)
        _clear_board(db)
        # 자식(dev)에 edit 공유 → dev 멤버 편집 가능, dx(상위) 멤버는 불가.
        gs.upsert_board_grant(
            db, BOARD, GrantPrincipalType.workspace, CHILD_WS, GrantLevel.edit
        )
        db.commit()
        assert gs._board_edit_reaches(db, [BOARD], child_uid)
        assert not gs._board_edit_reaches(db, [BOARD], parent_uid)
    finally:
        _clear_board(db)
        db.close()


def test_board_all_org_admits_nonmember_readonly():
    """게시판을 all_org 공유하면 무소속 사용자가 그 게시판 보고서를 읽기전용 열람."""
    client = TestClient(app)
    outsider = _ensure_user("board-outsider@test.local", None)

    def admin_h(ws):
        return {"Authorization": f"Bearer {create_access_token(1)}", "X-Workspace-Slug": ws}

    # 보고서 생성 + BOARD 게시
    tpl = client.get("/api/templates", headers=admin_h(PARENT_WS)).json()["data"][0]
    rep = client.post(
        "/api/reports",
        headers=admin_h(PARENT_WS),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "게시판공개 테스트",
            "tags": [],
        },
    )
    rid = rep.json()["data"]["id"]
    mnt = client.post(
        "/api/mounts",
        headers=admin_h(PARENT_WS),
        json={"report_id": rid, "workspace_slugs": [BOARD]},
    )
    assert mnt.status_code == 200, mnt.text

    out_h = {"Authorization": f"Bearer {create_access_token(outsider)}", "X-Workspace-Slug": BOARD}
    try:
        # 공유 전 — 무소속은 진입/열람 불가.
        assert client.get(f"/api/reports/{rid}", headers=out_h).status_code == 403
        # 게시판 all_org 공유(admin=시스템관리자 → 매니저 게이트 통과).
        shared = client.post(
            f"/api/workspaces/{BOARD}/shares",
            headers=admin_h(PARENT_WS),
            json={"principal_type": "all_org"},
        )
        assert shared.status_code == 201, shared.text
        # 공유 후 — 200 + 읽기전용.
        got = client.get(f"/api/reports/{rid}", headers=out_h)
        assert got.status_code == 200, got.text
        assert got.json()["data"]["is_public_view"] is True
    finally:
        # 정리: 게시판 공유 제거 + 보고서 삭제.
        lst = client.get(f"/api/workspaces/{BOARD}/shares", headers=admin_h(PARENT_WS))
        if lst.status_code == 200:
            for g in lst.json()["data"]:
                client.delete(
                    f"/api/workspaces/{BOARD}/shares/{g['id']}",
                    headers=admin_h(PARENT_WS),
                )
        client.delete(f"/api/reports/{rid}", headers=admin_h(PARENT_WS))
