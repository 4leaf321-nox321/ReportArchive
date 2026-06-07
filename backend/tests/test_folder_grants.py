"""폴더(folder) 통째 공유 — 도달성 단위 + all_org 비멤버 진입 e2e.

게시판 공유와 동형이되 폴더 단위(보고서의 mount.folder_id 경유).
트리: dx → division-mx → dev → dev-hw → ...
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.grants import services as gs
from app.modules.grants.models import FolderGrant, GrantLevel, GrantPrincipalType
from app.modules.users.models import Role, User, WorkspaceMember

BOARD = "dev-hw"
PARENT_WS = "dx"
CHILD_WS = "dev"


class _WS:
    def __init__(self, slug):
        self.slug = slug
        self.virtual = False


class _U:
    def __init__(self, uid):
        self.id = uid
        self.is_system_admin = False


class _Actor:
    def __init__(self, uid, slug):
        self.user = _U(uid)
        self.workspace = _WS(slug)
        self.public_viewer = False


def _ensure_user(email, ws):
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


def _admin_h(ws=PARENT_WS):
    return {"Authorization": f"Bearer {create_access_token(1)}", "X-Workspace-Slug": ws}


def test_folder_reach_downward_and_edit():
    client = TestClient(app)
    parent_uid = _ensure_user("folder-parent@test.local", PARENT_WS)
    child_uid = _ensure_user("folder-child@test.local", CHILD_WS)
    # org 폴더 생성(BOARD).
    fres = client.post(
        f"/api/folders?workspace_slug={BOARD}",
        headers=_admin_h(),
        json={"name": "폴더공유-단위테스트"},
    )
    assert fres.status_code == 201, fres.text
    fid = fres.json()["data"]["id"]
    db = SessionLocal()
    try:
        # view 공유를 자식(dev)에 → dev 컨텍스트 도달, 부모(dx)는 도달 안 함.
        gs.upsert_folder_grant(db, fid, GrantPrincipalType.workspace, CHILD_WS, GrantLevel.view)
        db.commit()
        assert gs._folder_view_reaches(db, [fid], _Actor(child_uid, CHILD_WS), include_all_org=True)
        assert not gs._folder_view_reaches(db, [fid], _Actor(parent_uid, PARENT_WS), include_all_org=True)
        # edit 공유를 자식(dev)에 → dev 멤버 편집, dx 멤버 불가.
        db.query(FolderGrant).filter_by(folder_id=fid).delete()
        gs.upsert_folder_grant(db, fid, GrantPrincipalType.workspace, CHILD_WS, GrantLevel.edit)
        db.commit()
        assert gs._folder_edit_reaches(db, [fid], child_uid)
        assert not gs._folder_edit_reaches(db, [fid], parent_uid)
    finally:
        db.query(FolderGrant).filter_by(folder_id=fid).delete()
        db.commit()
        db.close()
        client.delete(f"/api/folders/{fid}", headers=_admin_h())


def test_folder_all_org_admits_nonmember_readonly():
    client = TestClient(app)
    outsider = _ensure_user("folder-outsider@test.local", None)
    # 폴더 생성 + 보고서 그 폴더에 게시.
    fid = client.post(
        f"/api/folders?workspace_slug={BOARD}",
        headers=_admin_h(),
        json={"name": "폴더공개-테스트"},
    ).json()["data"]["id"]
    tpl = client.get("/api/templates", headers=_admin_h()).json()["data"][0]
    rid = client.post(
        "/api/reports",
        headers=_admin_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "폴더공개 보고서",
            "tags": [],
        },
    ).json()["data"]["id"]
    mnt = client.post(
        "/api/mounts",
        headers=_admin_h(),
        json={"report_id": rid, "workspace_slugs": [BOARD], "folder_id": fid},
    )
    assert mnt.status_code == 200, mnt.text
    out_h = {"Authorization": f"Bearer {create_access_token(outsider)}", "X-Workspace-Slug": BOARD}
    try:
        # 공유 전 — 무소속 403.
        assert client.get(f"/api/reports/{rid}", headers=out_h).status_code == 403
        # 폴더 all_org 공유.
        shared = client.post(
            f"/api/folders/{fid}/shares",
            headers=_admin_h(),
            json={"principal_type": "all_org"},
        )
        assert shared.status_code == 201, shared.text
        # 공유 후 — 200 읽기전용.
        got = client.get(f"/api/reports/{rid}", headers=out_h)
        assert got.status_code == 200, got.text
        assert got.json()["data"]["is_public_view"] is True
        # 폴더 목록이 shares 요약(all_org)을 내려준다 — 뱃지/호버용.
        flist = client.get(
            f"/api/folders?workspace_slug={BOARD}", headers=_admin_h()
        ).json()["data"]["items"]
        target = next((f for f in flist if f["id"] == fid), None)
        assert target is not None
        assert any(s["principal_type"] == "all_org" for s in target["shares"])
    finally:
        lst = client.get(f"/api/folders/{fid}/shares", headers=_admin_h())
        if lst.status_code == 200:
            for g in lst.json()["data"]:
                client.delete(f"/api/folders/{fid}/shares/{g['id']}", headers=_admin_h())
        client.delete(f"/api/reports/{rid}", headers=_admin_h())
        client.delete(f"/api/folders/{fid}", headers=_admin_h())
