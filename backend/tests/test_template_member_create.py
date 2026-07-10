"""일반 멤버의 '자기 부서 템플릿' 생성/관리 권한 (라우트 헬퍼 단위 테스트).

매니저 기존 동작은 유지하면서, 일반 멤버(role=user)는 *자기 부서* 단독 소유
템플릿만 생성/수정/삭제할 수 있다(전사공개·타부서·공유는 매니저 영역).

시드 트리: dev(root) ├ dev-platform ├ dev-product ...
"""
import itertools

import pytest
from fastapi import HTTPException

from app.database import SessionLocal
from app.modules.templates.routes import (
    _assert_can_create_template,
    _assert_can_manage_template,
)
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace
from app.shared.auth import CurrentUser


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


# 새 유저 id 는 시드(2·3)와 겹치지 않게 높은 번호부터. 픽스처가 롤백하므로 격리됨.
_uid = itertools.count(900001)


def _actor(db, slug, role):
    """`slug` 에 `role` 멤버십을 가진 **전용 유저**로 CurrentUser 를 만든다.

    권한이 이제 **계정 멤버십**(활성부서 무관)으로 판정되므로, 역할을 필드로만
    씌우지 않고 실제 WorkspaceMember row 를 심어야 한다. 시드 유저 id3 은 dev·dx
    매니저라 멤버 경계 테스트를 오염시키므로, 멤버십이 전혀 없는 새 유저를 쓴다.
    """
    ws = db.get(Workspace, slug)
    assert ws is not None, f"seed missing workspace {slug}"
    user = User(
        id=next(_uid),
        email=f"perm-test-{next(_uid)}@seed.local",
        name="권한 경계 테스트 유저",
        password_hash="x",  # 로그인 안 하므로 해시 불필요(NOT NULL 만 충족).
        is_active=True,
        is_system_admin=False,
    )
    db.add(user)
    db.flush()
    db.add(WorkspaceMember(user_id=user.id, workspace_slug=slug, role=role))
    db.flush()
    return CurrentUser(user=user, workspace=ws, role=role)


class _T:
    def __init__(self, owners):
        self.owner_workspace_slugs = owners


# ── 생성 ────────────────────────────────────────────────────────────────
def test_member_can_create_own_dept(db):
    _assert_can_create_template(db, _actor(db, "dev-hw", Role.user), ["dev-hw"])


def test_member_cannot_create_global(db):
    with pytest.raises(HTTPException) as e:
        _assert_can_create_template(db, _actor(db, "dev-hw", Role.user), [])
    assert e.value.status_code == 403


def test_member_cannot_create_other_dept(db):
    with pytest.raises(HTTPException):
        _assert_can_create_template(db, _actor(db, "dev-hw", Role.user), ["dev"])


def test_member_cannot_create_multi_dept(db):
    with pytest.raises(HTTPException):
        _assert_can_create_template(
            db, _actor(db, "dev-hw", Role.user), ["dev-hw", "dev"]
        )


def test_manager_can_create_global(db):
    _assert_can_create_template(db, _actor(db, "dev", Role.manager), [])


def test_manager_can_create_descendant(db):
    _assert_can_create_template(db, _actor(db, "dev", Role.manager), ["dev-hw"])


def test_manager_cannot_create_outside_tree(db):
    with pytest.raises(HTTPException):
        _assert_can_create_template(db, _actor(db, "dev-hw", Role.manager), ["dev"])


# ── 기존 템플릿 관리(새 버전/삭제) ────────────────────────────────────────
def test_member_can_manage_own_dept_template(db):
    _assert_can_manage_template(_actor(db, "dev-hw", Role.user), _T(["dev-hw"]))


def test_member_cannot_manage_other_dept_template(db):
    with pytest.raises(HTTPException):
        _assert_can_manage_template(_actor(db, "dev-hw", Role.user), _T(["dev"]))


def test_member_cannot_manage_global_template(db):
    with pytest.raises(HTTPException):
        _assert_can_manage_template(_actor(db, "dev-hw", Role.user), _T([]))


def test_manager_can_manage_visible_template(db):
    # 매니저는 is_visible 통과분이면 관리 가능(여기선 헬퍼만 검사 → 항상 통과).
    _assert_can_manage_template(_actor(db, "dev", Role.manager), _T(["dev"]))


def test_public_viewer_blocked(db):
    actor = _actor(db, "dev-hw", Role.user)
    actor.public_viewer = True
    with pytest.raises(HTTPException):
        _assert_can_create_template(db, actor, ["dev-hw"])
