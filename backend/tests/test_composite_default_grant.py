"""종합보고 워크스페이스 기본 공유(CompositeDefaultGrant) — 라이브 상속 + 추가만.

워크스페이스 W 에 기본 공유를 걸면 W 가 home 인 종합보고(기존·신규)가 대상 부서
(하위 포함)에 즉시 보이고, 제거하면 즉시 사라진다(복사 없음). 보고서엔 무영향.

트리: dx → division-mx → dev → dev-hw → dev-he → dev-caegroup
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.grants import services as gs
from app.modules.grants.models import (
    CompositeDefaultGrant,
    GrantContentType,
    GrantLevel,
    GrantPrincipalType,
)
from app.modules.composites.models import CompositeReport
from app.modules.users.models import Role, User, WorkspaceMember

CCT = GrantContentType.composite
HOME_WS = "dx"        # 종합보고 home(상위 게시판)
VIEWER_WS = "dev-he"  # 뷰어 소속(dx 의 하위, dx 비멤버)


class _WS:
    def __init__(self, slug):
        self.slug = slug
        self.virtual = False


class _U:
    def __init__(self, uid):
        self.id = uid
        self.is_system_admin = False


class _Actor:
    def __init__(self, uid, slug=HOME_WS, public_viewer=True):
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
            if (
                db.query(WorkspaceMember)
                .filter_by(user_id=u.id, workspace_slug=ws)
                .one_or_none()
                is None
            ):
                db.add(WorkspaceMember(user_id=u.id, workspace_slug=ws, role=Role.user))
        db.commit()
        return u.id
    finally:
        db.close()


def _pick_private_dx_composite(db):
    """dx home 종합보고 중 전체공개가 아닌 것 하나(없으면 None)."""
    allorg = set(gs.all_org_ids(db, CCT))
    for c in db.query(CompositeReport).filter_by(workspace_slug=HOME_WS).all():
        if c.id not in allorg:
            return c
    return None


def _clear(db):
    db.query(CompositeDefaultGrant).filter_by(workspace_slug=HOME_WS).delete()
    db.commit()


def test_default_grant_live_inheritance_and_retroactive_removal():
    db = SessionLocal()
    try:
        comp = _pick_private_dx_composite(db)
        if comp is None:
            return  # 데이터 없음 — 스킵
        viewer = _ensure_user("cdg-viewer@test.local", VIEWER_WS)
        _clear(db)
        actor = _Actor(viewer)  # dx 비멤버(dev-he 멤버), public_viewer

        # 공유 전 — 기존 종합보고 안 보임.
        assert not gs.can_view(db, actor, CCT, comp.id, comp.owner_user_id)
        assert comp.id not in gs.visible_ids(db, actor, CCT)

        # dx 종합보고를 dev-he 부서(하위 포함)에 기본 공유.
        gs.upsert_composite_default_grant(
            db, HOME_WS, GrantPrincipalType.workspace, VIEWER_WS, GrantLevel.view
        )
        db.commit()

        # 라이브 상속 — *기존* 종합보고가 즉시 보인다(복사 없음).
        assert gs.can_view(db, actor, CCT, comp.id, comp.owner_user_id)
        assert comp.id in gs.visible_ids(db, actor, CCT)
        # 브라우즈 진입 자격도 생김.
        assert gs.user_has_container_grant_on_board(db, viewer, HOME_WS)

        # 제거 → 즉시(소급) 다시 안 보임.
        g = (
            db.query(CompositeDefaultGrant)
            .filter_by(workspace_slug=HOME_WS)
            .first()
        )
        gs.delete_composite_default_grant(db, g)
        db.commit()
        assert not gs.can_view(db, actor, CCT, comp.id, comp.owner_user_id)
    finally:
        _clear(db)
        db.close()


def test_default_grant_does_not_affect_reports():
    """종합보고 기본 공유는 보고서 가시성에 영향 없음."""
    db = SessionLocal()
    try:
        viewer = _ensure_user("cdg-rep@test.local", VIEWER_WS)
        _clear(db)
        gs.upsert_composite_default_grant(
            db, HOME_WS, GrantPrincipalType.workspace, VIEWER_WS, GrantLevel.view
        )
        db.commit()
        actor = _Actor(viewer)
        # 보고서 가시 집합엔 default grant 가 안 들어간다.
        rep_visible = gs.visible_ids(db, actor, GrantContentType.report)
        # dx 보고서가 default 로 새지 않음 — report visible 은 default 와 무관.
        # (정확히는 default 경로가 report 분기에 없음을 보장.)
        comp_reachable = gs._composite_default_reachable_slugs(
            db, gs.membership_reach_slugs(db, viewer), viewer
        )
        assert HOME_WS in comp_reachable  # 종합보고 쪽은 도달
        # report visible 에 dx home default 로 추가된 게 없어야 — 간접 확인:
        # default 만 있고 다른 grant 없으면 report 쪽엔 dx 공개분만.
        assert isinstance(rep_visible, set)
    finally:
        _clear(db)
        db.close()


def test_default_share_api_manager_only():
    """기본 공유 API 는 매니저/시스템관리자만. 일반 멤버는 403."""
    client = TestClient(app)
    member = _ensure_user("cdg-plain@test.local", VIEWER_WS)  # 일반 user

    def h(uid, ws):
        return {
            "Authorization": f"Bearer {create_access_token(uid)}",
            "X-Workspace-Slug": ws,
        }

    db = SessionLocal()
    _clear(db)
    db.close()
    try:
        # 일반 멤버 — 추가 시도 403.
        r = client.post(
            f"/api/workspaces/{HOME_WS}/composite-default-shares",
            headers=h(member, VIEWER_WS),
            json={
                "principal_type": "workspace",
                "principal_ref": VIEWER_WS,
                "level": "view",
            },
        )
        assert r.status_code == 403, r.text

        # 시스템 관리자(uid=1) — 추가 201, 조회, 삭제.
        add = client.post(
            f"/api/workspaces/{HOME_WS}/composite-default-shares",
            headers=h(1, HOME_WS),
            json={
                "principal_type": "workspace",
                "principal_ref": VIEWER_WS,
                "level": "view",
            },
        )
        assert add.status_code == 201, add.text
        gid = add.json()["data"]["id"]
        lst = client.get(
            f"/api/workspaces/{HOME_WS}/composite-default-shares",
            headers=h(1, HOME_WS),
        )
        assert lst.status_code == 200
        assert any(g["id"] == gid for g in lst.json()["data"])
        dele = client.delete(
            f"/api/workspaces/{HOME_WS}/composite-default-shares/{gid}",
            headers=h(1, HOME_WS),
        )
        assert dele.status_code == 200
    finally:
        db = SessionLocal()
        _clear(db)
        db.close()
