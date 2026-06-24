"""TF(태스크포스) 조직 — 개설 거버넌스·멤버십 스코프 가시성·상속 격리·archived 읽기전용.

설계: TF조직_설계.md §10. dev DB 직결(다른 통합 테스트와 동일). org 트리:
dx → division-mx → dev → dev-hw. TF 는 트리 밖(parent_slug=NULL).
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace, WorkspaceKind, WorkspaceStatus
from app.shared.auth import CurrentUser, get_current_user, require_writer

client = TestClient(app)

LEAD = "tf_lead@tf.test"          # dev(org) 매니저 → 보직장
PLAIN = "tf_plain@tf.test"        # dev 일반 멤버 → 보직장 아님
OUTSIDER = "tf_outsider@tf.test"  # dx(org, dev 의 상위) 매니저 — TF 비멤버
RECRUIT = "tf_recruit@tf.test"    # 다른 부서(dev-he) — cross-dept 차출 대상


def _ensure_user(email: str, org_slug: str | None, role: Role) -> int:
    db = SessionLocal()
    try:
        u = db.query(User).filter_by(email=email).one_or_none()
        if u is None:
            u = User(email=email, name=email, password_hash="!unused-tests-only")
            db.add(u)
            db.flush()
        if org_slug is not None:
            m = (
                db.query(WorkspaceMember)
                .filter_by(user_id=u.id, workspace_slug=org_slug)
                .one_or_none()
            )
            if m is None:
                db.add(
                    WorkspaceMember(
                        user_id=u.id, workspace_slug=org_slug, role=role
                    )
                )
            else:
                m.role = role
        db.commit()
        return u.id
    finally:
        db.close()


def _hdr(uid: int, ws: str | None = None) -> dict:
    h = {"Authorization": f"Bearer {create_access_token(uid)}"}
    if ws is not None:
        h["X-Workspace-Slug"] = ws
    return h


def _cleanup_tf_of(creator_uid: int) -> None:
    """이 테스트가 만든 TF + 그 멤버십 정리(반복 실행 멱등)."""
    db = SessionLocal()
    try:
        tfs = (
            db.query(Workspace)
            .filter(
                Workspace.kind == WorkspaceKind.tf,
                Workspace.created_by_user_id == creator_uid,
            )
            .all()
        )
        for tf in tfs:
            db.query(WorkspaceMember).filter_by(workspace_slug=tf.slug).delete()
            db.delete(tf)
        db.commit()
    finally:
        db.close()


@pytest.fixture()
def users():
    lead = _ensure_user(LEAD, "dev", Role.manager)
    plain = _ensure_user(PLAIN, "dev", Role.user)
    outsider = _ensure_user(OUTSIDER, "dx", Role.manager)
    recruit = _ensure_user(RECRUIT, "dev-he", Role.user)
    _cleanup_tf_of(lead)
    yield SimpleNamespace(
        lead=lead, plain=plain, outsider=outsider, recruit=recruit
    )
    _cleanup_tf_of(lead)


def _create_tf(uid: int, name="시험 TF", members=None) -> dict:
    body = {"name": name, "description": "", "member_emails": members or []}
    res = client.post("/api/workspaces/tf", json=body, headers=_hdr(uid))
    return res


# --------------------------------------------------------------------------- #
# 개설 거버넌스
# --------------------------------------------------------------------------- #
def test_lead_can_create_tf_plain_cannot(users):
    # 보직장(dev 매니저)은 개설 가능
    res = _create_tf(users.lead)
    assert res.status_code == 201, res.text
    data = res.json()["data"]
    assert data["kind"] == "tf"
    assert data["status"] == "active"
    assert data["parent_slug"] is None
    assert data["created_by_user_id"] == users.lead
    slug = data["slug"]

    # 개설자는 그 TF 의 매니저
    db = SessionLocal()
    try:
        m = (
            db.query(WorkspaceMember)
            .filter_by(user_id=users.lead, workspace_slug=slug)
            .one()
        )
        assert m.role == Role.manager
    finally:
        db.close()

    # 일반 멤버(dev user)는 개설 불가
    res2 = _create_tf(users.plain)
    assert res2.status_code == 403, res2.text


def test_cross_dept_recruit_on_create(users):
    res = _create_tf(users.lead, members=[RECRUIT])
    assert res.status_code == 201, res.text
    slug = res.json()["data"]["slug"]
    db = SessionLocal()
    try:
        m = (
            db.query(WorkspaceMember)
            .filter_by(user_id=users.recruit, workspace_slug=slug)
            .one_or_none()
        )
        # 다른 부서(dev-he) 사용자가 부서 무관하게 차출됨
        assert m is not None and m.role == Role.user
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# 멤버십 스코프 가시성 + 상속 격리
# --------------------------------------------------------------------------- #
def test_tf_visibility_is_membership_scoped(users):
    slug = _create_tf(users.lead, members=[RECRUIT]).json()["data"]["slug"]

    def _list_slugs(uid):
        res = client.get("/api/workspaces", headers=_hdr(uid))
        assert res.status_code == 200
        return {w["slug"] for w in res.json()["data"]}

    # 멤버(개설자·차출자)에겐 보이고
    assert slug in _list_slugs(users.lead)
    assert slug in _list_slugs(users.recruit)
    # 비멤버에겐 — dx(상위 부서) 매니저라도 — 안 보인다(상속 없음 + 스코프)
    assert slug not in _list_slugs(users.outsider)
    assert slug not in _list_slugs(users.plain)


def test_non_member_cannot_enter_tf_context(users):
    slug = _create_tf(users.lead).json()["data"]["slug"]
    # 멤버는 TF 컨텍스트 진입 OK(목록 조회 200)
    ok = client.get("/api/reports", headers=_hdr(users.lead, slug))
    assert ok.status_code == 200, ok.text
    # 상위 부서 매니저(비멤버)는 403 — 트리 상속이 TF 로 새지 않음
    denied = client.get("/api/reports", headers=_hdr(users.outsider, slug))
    assert denied.status_code == 403, denied.text


# --------------------------------------------------------------------------- #
# Archived 읽기전용 보존
# --------------------------------------------------------------------------- #
def test_archive_toggle_and_permissions(users):
    slug = _create_tf(users.lead).json()["data"]["slug"]

    # 비매니저(차출 전 outsider)는 보관 불가
    bad = client.patch(
        f"/api/workspaces/{slug}/archive",
        json={"archived": True},
        headers=_hdr(users.outsider),
    )
    assert bad.status_code == 403, bad.text

    # 매니저(개설자)는 보관 가능
    res = client.patch(
        f"/api/workspaces/{slug}/archive",
        json={"archived": True},
        headers=_hdr(users.lead),
    )
    assert res.status_code == 200, res.text
    assert res.json()["data"]["status"] == "archived"

    # 복원
    res2 = client.patch(
        f"/api/workspaces/{slug}/archive",
        json={"archived": False},
        headers=_hdr(users.lead),
    )
    assert res2.status_code == 200
    assert res2.json()["data"]["status"] == "active"


def test_cannot_archive_org_workspace(users):
    res = client.patch(
        "/api/workspaces/dev/archive",
        json={"archived": True},
        headers=_hdr(users.lead),
    )
    assert res.status_code == 400, res.text


def test_archived_tf_member_is_read_only(users):
    slug = _create_tf(users.lead).json()["data"]["slug"]
    db = SessionLocal()
    try:
        tf = db.get(Workspace, slug)
        tf.status = WorkspaceStatus.archived
        db.commit()

        creds = HTTPAuthorizationCredentials(
            scheme="Bearer", credentials=create_access_token(users.lead)
        )
        cu = get_current_user(db=db, credentials=creds, x_workspace_slug=slug)
        # 멤버라 진입은 되지만(가시성 유지) read_only
        assert cu.read_only is True
        assert cu.can_write_reports is False
    finally:
        db.close()


def test_require_writer_blocks_read_only():
    actor = CurrentUser(
        user=SimpleNamespace(id=1),
        workspace=SimpleNamespace(virtual=False),
        role=Role.user,
        read_only=True,
    )
    with pytest.raises(HTTPException) as exc:
        require_writer(actor)
    assert exc.value.status_code == 403
