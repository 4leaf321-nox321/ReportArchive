"""템플릿 개방 모델 — 작성(scope=all) 전체 노출 + 렌더(by-id) 비소유 부서 개방.

배경: owner_workspace_slugs 를 *읽기·사용 가드* 로 쓰면 (1) 내 공간/타부서에서
작성 picker 에 일부 템플릿이 안 뜨고 (2) 소유 부서 비멤버가 다른 게시판에서 그
보고서를 보면 템플릿 스키마 404 로 "불러오는 중" 에서 멈춘다. 이제 소유 부서는
*분류·쓰기권한* 메타일 뿐, 읽기/사용은 열려 있다. 시드 트리: dev / biz / biz-sales.
"""
import uuid

import pytest
from sqlalchemy.orm import Session

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.templates import services
from app.modules.templates.models import Template
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace

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


def _make_template(db: Session, slugs):
    t = Template(
        template_id=f"open-{uuid.uuid4().hex[:8]}",
        version=1,
        name="t",
        description="",
        category="misc",
        schema=_SCHEMA,
        owner_workspace_slugs=slugs,
        is_published=True,
        is_latest=True,
        created_by_user_id=None,
    )
    db.add(t)
    db.flush()
    return t


# --------------------------------------------------------------------------- #
# Part B — 작성 picker(scope=all)는 소유 부서 무관 전체를 반환
# --------------------------------------------------------------------------- #
def test_all_scopes_lists_out_of_scope_templates(db):
    t = _make_template(db, ["biz-sales"])  # dev 트리 밖 소유
    scoped_ids = {x.template_id for x in services.list_templates(db, "dev")}
    all_ids = {
        x.template_id for x in services.list_templates(db, "dev", all_scopes=True)
    }
    # 기본(워크스페이스 스코프)에선 안 보이지만, all 에선 보인다.
    assert t.template_id not in scoped_ids
    assert t.template_id in all_ids


def test_private_template_only_owner_in_all_scopes(db):
    """개인(비공개) 템플릿(소유=personal-{id})은 scope=all 작성 picker 에서도
    소유자 본인에게만 보이고 남에겐 제외된다. (렌더 by-id 는 별개로 열려 있어
    그 템플릿으로 게시한 보고서는 모두에게 렌더됨 — 아래 render 테스트가 보장.)"""
    if db.get(Workspace, "personal-2") is None:
        pytest.skip("개인공간 시드 없음")
    t = _make_template(db, ["personal-2"])  # user id2 의 개인 비공개 템플릿
    assert services.is_private_template(t) is True
    owner_ids = {
        x.template_id
        for x in services.list_templates(db, "dev", all_scopes=True, user_id=2)
    }
    other_ids = {
        x.template_id
        for x in services.list_templates(db, "dev", all_scopes=True, user_id=3)
    }
    assert t.template_id in owner_ids
    assert t.template_id not in other_ids


def test_scoped_list_includes_my_created_out_of_scope(db):
    """'템플릿 관리'(scoped)는 현재 워크스페이스 가시 트리 밖이어도 **내가 만든**
    템플릿을 포함해야 한다 — 작성 picker(scope=all)엔 뜨는데 관리엔 안 떠 불일치
    하던 문제. 남(다른 사용자)에겐 여전히 안 보인다."""
    t = _make_template(db, ["biz-sales"])  # dev 트리 밖 소유
    t.created_by_user_id = 2  # user id2 가 생성
    db.flush()
    ids_creator = {
        x.template_id for x in services.list_templates(db, "dev", user_id=2)
    }
    ids_other = {
        x.template_id for x in services.list_templates(db, "dev", user_id=3)
    }
    assert t.template_id in ids_creator  # 생성자는 컨텍스트 무관 관리 목록에서 봄
    assert t.template_id not in ids_other  # 남은 가시 트리 밖이라 안 보임


def test_system_admin_sees_all_including_others_private(db):
    """시스템 관리자는 타인 개인(비공개) 포함 모든 템플릿을 본다 — 스코프/all 무관."""
    t_priv = _make_template(db, ["personal-999999"])  # 남의 개인 비공개
    t_dept = _make_template(db, ["biz-sales"])  # dev 트리 밖 부서
    scoped = {
        x.template_id
        for x in services.list_templates(db, "dev", is_system_admin=True)
    }
    picker = {
        x.template_id
        for x in services.list_templates(
            db, "dev", all_scopes=True, is_system_admin=True
        )
    }
    for ids in (scoped, picker):
        assert t_priv.template_id in ids
        assert t_dept.template_id in ids
    # 대조: 비-관리자(user_id 지정)는 남의 개인 비공개를 못 본다.
    non_admin = {
        x.template_id
        for x in services.list_templates(db, "dev", all_scopes=True, user_id=3)
    }
    assert t_priv.template_id not in non_admin


def test_personal_space_all_scopes_sees_dept_template(db):
    """내 공간 컨텍스트는 _visible_slugs_for 가 {personal-X} 뿐이라 기본으론
    전사 템플릿만 보이지만, scope=all 이면 부서 템플릿도 전부 보인다."""
    t = _make_template(db, ["dev"])
    personal = "personal-2"  # conftest 가 보장하는 사용자(id2)의 개인공간
    if db.get(Workspace, personal) is None:
        pytest.skip("개인공간 시드 없음")
    scoped_ids = {x.template_id for x in services.list_templates(db, personal)}
    all_ids = {
        x.template_id
        for x in services.list_templates(db, personal, all_scopes=True)
    }
    assert t.template_id not in scoped_ids
    assert t.template_id in all_ids


# --------------------------------------------------------------------------- #
# Part A — 렌더(by-id)는 소유 부서 비멤버에게도 열려 있다(200)
# --------------------------------------------------------------------------- #
def _ensure_member(email: str, slug: str) -> int:
    db = SessionLocal()
    try:
        u = db.query(User).filter_by(email=email).one_or_none()
        if u is None:
            u = User(
                email=email,
                name=email,
                password_hash="!unused-tests-only",
                is_system_admin=False,
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


def test_create_private_template_e2e():
    """일반 멤버가 개인(비공개) 템플릿을 만들면 — 남의 작성 picker(scope=all)엔
    안 뜨지만 by-id 렌더는 열려 있어, 그 템플릿으로 게시한 보고서는 모두에게
    표시된다(핵심 요구)."""
    owner = _ensure_member("tpl-priv-owner@test.local", "dev")
    other = _ensure_member("tpl-priv-other@test.local", "dev")
    tid = f"priv-{uuid.uuid4().hex[:8]}"
    h_owner = {
        "Authorization": f"Bearer {create_access_token(owner)}",
        "X-Workspace-Slug": "dev",
    }
    h_other = {
        "Authorization": f"Bearer {create_access_token(other)}",
        "X-Workspace-Slug": "dev",
    }
    try:
        # 생성 — 일반 멤버도 본인 personal 소유(비공개) 허용.
        r = client.post(
            "/api/templates",
            json={
                "template_id": tid,
                "name": "내 비공개 양식",
                "description": "",
                "category": "misc",
                "schema": _SCHEMA,
                "owner_workspace_slugs": [f"personal-{owner}"],
            },
            headers=h_owner,
        )
        assert r.status_code == 201, r.text

        def _ids(headers):
            res = client.get("/api/templates?scope=all", headers=headers)
            assert res.status_code == 200, res.text
            return {t["template_id"] for t in res.json()["data"]}

        # 소유자 작성 picker엔 보이고, 남에겐 안 보인다.
        assert tid in _ids(h_owner)
        assert tid not in _ids(h_other)

        # 그래도 남이 by-id 로 렌더는 할 수 있다(게시한 보고서가 표시되도록).
        rr = client.get(f"/api/templates/{tid}/versions/1", headers=h_other)
        assert rr.status_code == 200, rr.text
        assert rr.json()["data"]["template_id"] == tid
    finally:
        db = SessionLocal()
        try:
            db.query(Template).filter_by(template_id=tid).delete()
            db.commit()
        finally:
            db.close()


def test_render_by_id_open_to_non_owner_member():
    db = SessionLocal()
    try:
        # dev 에만 속한 비-시스템관리자 사용자(소유 부서 biz-sales 비멤버).
        u = (
            db.query(User)
            .filter_by(email="tpl-open-nonowner@test.local")
            .one_or_none()
        )
        if u is None:
            u = User(
                email="tpl-open-nonowner@test.local",
                name="tpl open nonowner",
                password_hash="!unused-tests-only",
                is_system_admin=False,
            )
            db.add(u)
            db.flush()
        if (
            db.query(WorkspaceMember)
            .filter_by(user_id=u.id, workspace_slug="dev")
            .first()
            is None
        ):
            db.add(
                WorkspaceMember(user_id=u.id, workspace_slug="dev", role=Role.user)
            )
        tid = f"open-{uuid.uuid4().hex[:8]}"
        db.add(
            Template(
                template_id=tid,
                version=1,
                name="biz template",
                description="",
                category="misc",
                schema=_SCHEMA,
                owner_workspace_slugs=["biz-sales"],  # u 가 비멤버인 부서 소유
                is_published=True,
                is_latest=True,
                created_by_user_id=None,
            )
        )
        db.commit()
        uid = u.id
    finally:
        db.close()

    try:
        h = {
            "Authorization": f"Bearer {create_access_token(uid)}",
            "X-Workspace-Slug": "dev",  # 소유 부서가 아닌 컨텍스트
        }
        # 단건/버전 모두 200(과거엔 가시성 가드로 404).
        r_ver = client.get(f"/api/templates/{tid}/versions/1", headers=h)
        assert r_ver.status_code == 200, r_ver.text
        assert r_ver.json()["data"]["template_id"] == tid

        r_latest = client.get(f"/api/templates/{tid}", headers=h)
        assert r_latest.status_code == 200, r_latest.text

        r_versions = client.get(f"/api/templates/{tid}/versions", headers=h)
        assert r_versions.status_code == 200, r_versions.text
    finally:
        db = SessionLocal()
        try:
            db.query(Template).filter_by(template_id=tid).delete()
            db.commit()
        finally:
            db.close()
