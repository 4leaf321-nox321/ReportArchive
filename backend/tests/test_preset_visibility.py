"""프리셋(시작 양식) 접근 모델 — 템플릿과 동형.

작성 picker(scope=all)는 소유 부서 무관 전체(내 공간에서 모든 부서 프리셋으로 시작
가능), 단 남의 개인(비공개)은 제외. scoped 목록은 가시 트리 + 전사 + 내 개인 +
내가 만든 것. 시스템 관리자는 전체. instantiate 는 id 로 열려 있어 어느 프리셋이든
새 보고서로 만들 수 있다(가시성 가드는 목록에만). 시드 트리: dev / biz / biz-sales.
"""
import uuid

import pytest
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.modules.presets import services as preset_services
from app.modules.presets.models import ReportPreset
from app.modules.templates.models import Template

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


def _make_template(db: Session) -> Template:
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
    return t


def _make_preset(db, tpl, owners, created_by=None) -> ReportPreset:
    p = ReportPreset(
        name="p",
        description="",
        template_id=tpl.template_id,
        template_version=1,
        owner_workspace_slugs=owners,
        seed={},
        created_by_user_id=created_by,
    )
    db.add(p)
    db.flush()
    return p


def test_all_scopes_lists_out_of_scope_preset(db):
    p = _make_preset(db, _make_template(db), ["biz-sales"])  # dev 트리 밖
    scoped = {x.id for x in preset_services.list_visible(db, "dev")}
    all_ = {x.id for x in preset_services.list_visible(db, "dev", all_scopes=True)}
    assert p.id not in scoped
    assert p.id in all_


def test_private_preset_only_owner_in_all_scopes(db):
    p = _make_preset(db, _make_template(db), ["personal-2"])
    assert preset_services.is_private_preset(p) is True
    owner = {
        x.id
        for x in preset_services.list_visible(db, "dev", all_scopes=True, user_id=2)
    }
    other = {
        x.id
        for x in preset_services.list_visible(db, "dev", all_scopes=True, user_id=3)
    }
    assert p.id in owner
    assert p.id not in other


def test_scoped_includes_my_created_out_of_scope(db):
    p = _make_preset(db, _make_template(db), ["biz-sales"], created_by=2)
    creator = {x.id for x in preset_services.list_visible(db, "dev", user_id=2)}
    other = {x.id for x in preset_services.list_visible(db, "dev", user_id=3)}
    assert p.id in creator
    assert p.id not in other


def test_system_admin_sees_all_including_others_private(db):
    p = _make_preset(db, _make_template(db), ["personal-999999"])
    ids = {
        x.id for x in preset_services.list_visible(db, "dev", is_system_admin=True)
    }
    assert p.id in ids
