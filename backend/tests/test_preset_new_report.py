"""프리셋으로 새 보고서 시작(POST /api/presets/{id}/new-report).

핵심 회귀: 새 보고서는 **항상 caller 의 personal 공간**(personal-{user.id})에
생성되므로, 지금 보고 있는 게시판(X-Workspace-Slug)이 쓰기 불가여도 프리셋
시작이 막히면 안 된다. 예전엔 이 엔드포인트가 require_writer 로 활성 workspace 를
게이트해, 다른 조직 공개 게시판 열람·가상(통합) 부서·보관 TF 를 보던 중
"내 공간에 새 글" 을 프리셋으로 시작하면 "편집 권한 없음" 403 이 났다.
create_ai_draft·프리셋 update/delete 와 동일하게 get_current_user 로 게이트.
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.presets.models import ReportPreset
from app.modules.reports.models import Report
from app.modules.templates.models import Template
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace, WorkspaceKind
from app.modules.workspaces.services import ensure_personal_workspace

client = TestClient(app)

_SCHEMA = {
    "version": "widget-v1",
    "blocks": [{"id": "summary", "type": "rich_text", "props": {"label": "요약"}}],
}


def test_new_report_from_preset_ignores_active_board_write_gate():
    suffix = uuid.uuid4().hex[:8]
    virtual_slug = f"_test_virtual_{suffix}"
    tid = f"pretpl-{suffix}"

    db = SessionLocal()
    try:
        # 어느 부서든 소속된 일반 사용자(가상 부서 진입 자격).
        user = User(
            email=f"preset-new-{suffix}@test.local",
            name="preset-new",
            password_hash="!unused-tests-only",
            is_system_admin=False,
        )
        db.add(user)
        db.flush()
        db.add(WorkspaceMember(user_id=user.id, workspace_slug="dev", role=Role.user))
        ensure_personal_workspace(db, user)  # personal-{id} — 생성 대상 FK 보장.

        # 쓰기 불가한 활성 컨텍스트: 가상(통합) 부서. require_writer 라면 거절된다.
        db.add(
            Workspace(
                slug=virtual_slug,
                name="테스트 통합",
                virtual=True,
                kind=WorkspaceKind.virtual,
            )
        )
        # 커밋된 템플릿 + 그 템플릿의 프리셋.
        db.add(
            Template(
                template_id=tid, version=1, name="t", description="",
                category="misc", schema=_SCHEMA, owner_workspace_slugs=None,
                is_published=True, is_latest=True, created_by_user_id=None,
            )
        )
        db.flush()
        preset = ReportPreset(
            name="양식", description="", template_id=tid, template_version=1,
            owner_workspace_slugs=None, seed={}, created_by_user_id=user.id,
        )
        db.add(preset)
        db.commit()
        uid, pid = user.id, preset.id
    finally:
        db.close()

    created_report_id = None
    try:
        res = client.post(
            f"/api/presets/{pid}/new-report",
            json={"title": "새 보고서"},
            headers={
                "Authorization": f"Bearer {create_access_token(uid)}",
                # 쓰기 불가(가상) 게시판을 보던 중이어도 프리셋 시작은 성공해야.
                "X-Workspace-Slug": virtual_slug,
            },
        )
        assert res.status_code == 201, res.text
        data = res.json()["data"]
        created_report_id = data["id"]
        # 보고서는 활성 부서가 아니라 내 personal 공간에 태어난다.
        assert data["workspace_slug"] == f"personal-{uid}"
    finally:
        db = SessionLocal()
        try:
            if created_report_id is not None:
                r = db.get(Report, created_report_id)
                if r:
                    db.delete(r)  # 블록/버전 CASCADE
                    db.flush()  # 템플릿 벌크 삭제 전에 report FK 를 먼저 비운다.
            db.query(ReportPreset).filter_by(id=pid).delete()
            db.query(Template).filter_by(template_id=tid).delete()
            db.query(Workspace).filter_by(slug=virtual_slug).delete()
            db.query(WorkspaceMember).filter_by(user_id=uid).delete()
            db.query(Workspace).filter_by(personal_owner_user_id=uid).delete()
            db.query(User).filter_by(id=uid).delete()
            db.commit()
        finally:
            db.close()
