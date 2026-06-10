"""일반 멤버의 '자기 부서 템플릿' 생성/관리 권한 (라우트 헬퍼 단위 테스트).

매니저 기존 동작은 유지하면서, 일반 멤버(role=user)는 *자기 부서* 단독 소유
템플릿만 생성/수정/삭제할 수 있다(전사공개·타부서·공유는 매니저 영역).

시드 트리: dev(root) ├ dev-platform ├ dev-product ...
"""
import pytest
from fastapi import HTTPException

from app.database import SessionLocal
from app.modules.templates.routes import (
    _assert_can_create_template,
    _assert_can_manage_template,
)
from app.modules.users.models import Role, User
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


def _actor(db, slug, role):
    ws = db.get(Workspace, slug)
    assert ws is not None, f"seed missing workspace {slug}"
    user = db.get(User, 1)
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
