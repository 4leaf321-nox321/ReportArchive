"""통합 공유(content_grant) 핵심 불변식 테스트 — 공유/권한 개편.

가장 중요한 정확성: **하위 상속, 상위 자동 접근 없음.**
  - 부서 X 에 view 공유 → X 의 *하위* 게시판 컨텍스트에서 보임(downward),
    X 의 *상위* 컨텍스트에서는 안 보임.
  - 부서 X 에 edit 공유 → X 또는 그 하위 부서 멤버는 편집 가능,
    X 의 상위 부서 멤버는 편집 불가(상위 누수 방지).

트리(라이브 DB): dx → division-mx → dev → dev-hw → ...
grant 는 reports/composites 에 FK 가 없어 합성 content_id 로 순수 로직만 검증한다.
"""
from __future__ import annotations

from app.database import SessionLocal
from app.modules.grants import services as gs
from app.modules.grants.models import (
    ContentGrant,
    GrantContentType,
    GrantLevel,
    GrantPrincipalType,
)
from app.modules.users.models import Role, User, WorkspaceMember

CT = GrantContentType.report
TEST_CONTENT_ID = 999_000_001  # 실제 보고서 아님 — grant 로직 전용 합성 id

PARENT_WS = "dx"      # 루트(상위)
CHILD_WS = "dev"      # dx 의 자손(하위)


class _WS:
    def __init__(self, slug, virtual=False):
        self.slug = slug
        self.virtual = virtual


class _U:
    def __init__(self, uid, is_system_admin=False):
        self.id = uid
        self.is_system_admin = is_system_admin


class _Actor:
    def __init__(self, uid, slug, public_viewer=False, virtual=False):
        self.user = _U(uid)
        self.workspace = _WS(slug, virtual=virtual)
        self.public_viewer = public_viewer


def _ensure_user(db, email, slug) -> int:
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
        db.add(WorkspaceMember(user_id=u.id, workspace_slug=slug, role=Role.user))
    db.commit()
    return u.id


def _clear_grants(db):
    db.query(ContentGrant).filter_by(
        content_type=CT, content_id=TEST_CONTENT_ID
    ).delete()
    db.commit()


def test_downward_inheritance_and_no_upward():
    db = SessionLocal()
    try:
        parent_uid = _ensure_user(db, "grant-parent@test.local", PARENT_WS)
        child_uid = _ensure_user(db, "grant-child@test.local", CHILD_WS)
        _clear_grants(db)

        # ── view 공유를 부모(dx)에 ──────────────────────────────────────────
        gs.upsert_grant(
            db, CT, TEST_CONTENT_ID, GrantPrincipalType.workspace, PARENT_WS,
            GrantLevel.view,
        )
        db.commit()

        # 하위(dev) 컨텍스트에서 보임(downward).
        assert gs.can_view(db, _Actor(child_uid, CHILD_WS), CT, TEST_CONTENT_ID, None)
        # 부모(dx)에 공유한 걸 부모 컨텍스트도 당연히 봄.
        assert gs.can_view(db, _Actor(parent_uid, PARENT_WS), CT, TEST_CONTENT_ID, None)

        # ── view 공유를 자식(dev)에만 ───────────────────────────────────────
        _clear_grants(db)
        gs.upsert_grant(
            db, CT, TEST_CONTENT_ID, GrantPrincipalType.workspace, CHILD_WS,
            GrantLevel.view,
        )
        db.commit()
        # 자식 컨텍스트는 봄.
        assert gs.can_view(db, _Actor(child_uid, CHILD_WS), CT, TEST_CONTENT_ID, None)
        # 부모(dx) 컨텍스트에서는 *안* 보임(상위 자동 열람 없음).
        assert not gs.can_view(
            db, _Actor(parent_uid, PARENT_WS), CT, TEST_CONTENT_ID, None
        )
    finally:
        _clear_grants(db)
        db.close()


def test_edit_reach_downward_only():
    db = SessionLocal()
    try:
        parent_uid = _ensure_user(db, "grant-parent@test.local", PARENT_WS)
        child_uid = _ensure_user(db, "grant-child@test.local", CHILD_WS)
        _clear_grants(db)

        # edit 공유를 자식(dev)에 → 자식 멤버는 편집, 부모 멤버는 불가.
        gs.upsert_grant(
            db, CT, TEST_CONTENT_ID, GrantPrincipalType.workspace, CHILD_WS,
            GrantLevel.edit,
        )
        db.commit()
        assert gs.reachable_workspace_edit(db, CT, TEST_CONTENT_ID, child_uid)
        assert not gs.reachable_workspace_edit(db, CT, TEST_CONTENT_ID, parent_uid)

        # edit 공유를 부모(dx)에 → 부모·자식 멤버 모두 편집(downward).
        _clear_grants(db)
        gs.upsert_grant(
            db, CT, TEST_CONTENT_ID, GrantPrincipalType.workspace, PARENT_WS,
            GrantLevel.edit,
        )
        db.commit()
        assert gs.reachable_workspace_edit(db, CT, TEST_CONTENT_ID, child_uid)
        assert gs.reachable_workspace_edit(db, CT, TEST_CONTENT_ID, parent_uid)
    finally:
        _clear_grants(db)
        db.close()


def test_all_org_view_only_and_public_viewer():
    db = SessionLocal()
    try:
        outsider_uid = _ensure_user(db, "grant-outsider@test.local", CHILD_WS)
        _clear_grants(db)
        # all_org 는 view 전용 — upsert 가 edit 요청도 view 로 강제.
        g = gs.upsert_grant(
            db, CT, TEST_CONTENT_ID, GrantPrincipalType.all_org, None, GrantLevel.edit
        )
        db.commit()
        assert g.level == GrantLevel.view
        # public_viewer 는 all_org 만으로 열람.
        actor = _Actor(outsider_uid, PARENT_WS, public_viewer=True)
        assert gs.can_view(db, actor, CT, TEST_CONTENT_ID, None)
        # owner 분만 있고 all_org 없으면 public_viewer 는 못 봄.
        _clear_grants(db)
        assert not gs.can_view(db, actor, CT, TEST_CONTENT_ID, owner_user_id=outsider_uid)
    finally:
        _clear_grants(db)
        db.close()
