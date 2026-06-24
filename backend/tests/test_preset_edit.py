"""보고서 시작 양식(ReportPreset) 수정 — 메타 PATCH + 권한 게이트.

핵심: 수정 권한은 **작성자 또는 시스템관리자**만(삭제와 동일). ⚠ personal 컨텍스트
에선 모두가 자기 personal 의 매니저라, 매니저 게이트를 쓰면 아무나 남의 양식을
고칠 수 있는 구멍이 생긴다 — 그래서 is_manager 는 권한에 쓰지 않는다.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.presets import services as preset_services
from app.modules.presets.models import ReportPreset
from app.modules.presets.schemas import PresetUpdate
from app.modules.templates.models import Template
from app.modules.users.models import Role, User, WorkspaceMember

client = TestClient(app)

_SCHEMA = {
    "version": "widget-v1",
    "blocks": [{"id": "summary", "type": "rich_text", "props": {"label": "요약"}}],
}


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def test_update_metadata_service(db):
    t = Template(
        template_id=f"pretpl-{uuid.uuid4().hex[:8]}",
        version=1,
        name="t",
        description="",
        category="misc",
        schema=_SCHEMA,
        owner_workspace_slugs=None,
        is_published=True,
        is_latest=True,
        created_by_user_id=None,
    )
    db.add(t)
    db.flush()
    p = ReportPreset(
        name="old",
        description="",
        template_id=t.template_id,
        template_version=1,
        owner_workspace_slugs=None,
        seed={},
        created_by_user_id=2,
    )
    db.add(p)
    db.flush()

    preset_services.update(
        db,
        p,
        PresetUpdate(
            name="new name", description="desc", owner_workspace_slugs=["dev"]
        ),
    )
    assert p.name == "new name"
    assert p.description == "desc"
    assert p.owner_workspace_slugs == ["dev"]
    # 빈 배열 → 전사(None) 정규화.
    preset_services.update(db, p, PresetUpdate(owner_workspace_slugs=[]))
    assert p.owner_workspace_slugs is None


def _ensure_member(email, slug, admin=False):
    db = SessionLocal()
    try:
        u = db.query(User).filter_by(email=email).one_or_none()
        if u is None:
            u = User(
                email=email,
                name=email,
                password_hash="!unused-tests-only",
                is_system_admin=admin,
            )
            db.add(u)
            db.flush()
        if (
            db.query(WorkspaceMember)
            .filter_by(user_id=u.id, workspace_slug=slug)
            .first()
            is None
        ):
            db.add(WorkspaceMember(user_id=u.id, workspace_slug=slug, role=Role.user))
        db.commit()
        return u.id
    finally:
        db.close()


def test_patch_permission_creator_admin_only():
    creator = _ensure_member("preset-edit-owner@test.local", "dev")
    other = _ensure_member("preset-edit-other@test.local", "dev")
    admin = _ensure_member("preset-edit-admin@test.local", "dev", admin=True)

    # 커밋된 템플릿 + 프리셋(작성자=creator).
    db = SessionLocal()
    try:
        tid = f"pretpl-{uuid.uuid4().hex[:8]}"
        db.add(
            Template(
                template_id=tid,
                version=1,
                name="t",
                description="",
                category="misc",
                schema=_SCHEMA,
                owner_workspace_slugs=None,
                is_published=True,
                is_latest=True,
                created_by_user_id=None,
            )
        )
        db.flush()
        p = ReportPreset(
            name="orig",
            description="",
            template_id=tid,
            template_version=1,
            owner_workspace_slugs=None,
            seed={},
            created_by_user_id=creator,
        )
        db.add(p)
        db.commit()
        pid = p.id
    finally:
        db.close()

    def _patch(uid, name):
        return client.patch(
            f"/api/presets/{pid}",
            json={"name": name},
            headers={
                "Authorization": f"Bearer {create_access_token(uid)}",
                "X-Workspace-Slug": "dev",
            },
        )

    try:
        # 다른 사용자(비작성자·비관리자) — personal 컨텍스트 구멍 없이 거부.
        assert _patch(other, "hijack").status_code == 403
        # 작성자 — 허용.
        assert _patch(creator, "by creator").status_code == 200
        # 시스템관리자 — 허용.
        assert _patch(admin, "by admin").status_code == 200
    finally:
        db = SessionLocal()
        try:
            db.query(ReportPreset).filter_by(id=pid).delete()
            db.query(Template).filter_by(template_id=tid).delete()
            db.commit()
        finally:
            db.close()
