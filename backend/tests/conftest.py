"""테스트 공용 픽스처.

이 저장소의 통합 테스트들은 별도 테스트 DB 를 띄우지 않고 settings.database_url
이 가리키는 (개발) DB 에 직접 붙는다. 일부 오래된 테스트가 사용자 id 2(seeded
admin)·id 3(seeded manager)를 하드코딩하는데, 현재 시드는 id 1(admin)만 만든다
(scripts/seed_initial_data.py). 그래서 그 사용자가 없으면 인증이 401 로 떨어진다.

여기서 세션 시작 시 id 2·3 사용자를 **멱등하게 보장**해 그 간극을 메운다. 운영
시드와는 무관한 테스트 전용 보조이며, dev DB 에만 추가된다(분명히 식별되는
이메일). 근본적으로는 전용 테스트 DB + 결정적 시드(격리)가 정석이지만, 이 픽스처는
기존 테스트를 건드리지 않고 안전망을 되살리는 최소 조치다.
"""
from __future__ import annotations

import pytest

from app.database import SessionLocal
from app.modules.auth.services import hash_password
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace


# (id, email, name, is_system_admin) — 테스트가 가정하는 사용자.
_SEED_TEST_USERS = [
    (2, "test-admin-id2@seed.local", "테스트 관리자(id2)", True),
    (3, "test-manager-id3@seed.local", "테스트 매니저(id3)", False),
]
# 두 사용자에게 보장할 워크스페이스 멤버십(테스트가 X-Workspace-Slug 로 쓰는 것).
_SEED_MEMBER_WORKSPACES = ["dev", "dx"]


def _ensure_user(db, uid: int, email: str, name: str, is_admin: bool) -> None:
    if db.get(User, uid) is not None:
        return
    db.add(
        User(
            id=uid,
            email=email,
            name=name,
            password_hash=hash_password("test-password"),
            is_active=True,
            is_system_admin=is_admin,
        )
    )
    db.flush()


def _ensure_membership(db, uid: int, slug: str) -> None:
    if db.get(Workspace, slug) is None:
        return  # 해당 워크스페이스가 없으면 멤버십도 의미 없음(건너뜀)
    exists = (
        db.query(WorkspaceMember)
        .filter_by(user_id=uid, workspace_slug=slug)
        .first()
    )
    if exists is None:
        db.add(
            WorkspaceMember(user_id=uid, workspace_slug=slug, role=Role.manager)
        )


@pytest.fixture(scope="session", autouse=True)
def _seed_legacy_test_users():
    """id 2·3 사용자(+멤버십)를 세션 시작 시 한 번 보장."""
    db = SessionLocal()
    try:
        for uid, email, name, is_admin in _SEED_TEST_USERS:
            _ensure_user(db, uid, email, name, is_admin)
            for slug in _SEED_MEMBER_WORKSPACES:
                _ensure_membership(db, uid, slug)
        db.commit()
    finally:
        db.close()
    yield
