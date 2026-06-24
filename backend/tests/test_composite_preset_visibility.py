"""종합보고 양식(CompositePreset) 접근 모델 — 템플릿/보고서 프리셋과 동형.

작성 picker(scope=all)는 소유 부서 무관 전체(남의 개인 비공개 제외), scoped 목록은
가시 트리 + 전사 + 내 개인 + 내가 만든 것, 시스템 관리자는 전체. instantiate
(new-composite)는 id 로 열려 있어 목록만 연다. 시드 트리: dev / biz / biz-sales.
"""
import uuid

import pytest
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.modules.composite_presets import services as cp_services
from app.modules.composite_presets.models import CompositePreset


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _make(db: Session, owners, created_by=None) -> CompositePreset:
    p = CompositePreset(
        name=f"양식-{uuid.uuid4().hex[:6]}",
        description="",
        source_kind="recurring",
        owner_workspace_slugs=owners,
        seed={},
        created_by_user_id=created_by,
    )
    db.add(p)
    db.flush()
    return p


def test_all_scopes_lists_out_of_scope(db):
    p = _make(db, ["biz-sales"])  # dev 트리 밖
    scoped = {x.id for x in cp_services.list_visible(db, "dev")}
    all_ = {x.id for x in cp_services.list_visible(db, "dev", all_scopes=True)}
    assert p.id not in scoped
    assert p.id in all_


def test_private_only_owner_in_all_scopes(db):
    p = _make(db, ["personal-2"])
    assert cp_services.is_private_preset(p) is True
    owner = {
        x.id for x in cp_services.list_visible(db, "dev", all_scopes=True, user_id=2)
    }
    other = {
        x.id for x in cp_services.list_visible(db, "dev", all_scopes=True, user_id=3)
    }
    assert p.id in owner
    assert p.id not in other


def test_scoped_includes_my_created_out_of_scope(db):
    p = _make(db, ["biz-sales"], created_by=2)
    creator = {x.id for x in cp_services.list_visible(db, "dev", user_id=2)}
    other = {x.id for x in cp_services.list_visible(db, "dev", user_id=3)}
    assert p.id in creator
    assert p.id not in other


def test_system_admin_sees_all_including_others_private(db):
    p = _make(db, ["personal-999999"])
    ids = {x.id for x in cp_services.list_visible(db, "dev", is_system_admin=True)}
    assert p.id in ids
