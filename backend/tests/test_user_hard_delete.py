"""계정 하드삭제 — 조직개편·계정삭제_설계.md §6.

저흔적(잘못된 메일 가입) 계정은 완전 삭제되어 이메일이 해방되고, 흔적(작성 댓글·
개인공간 내용)이 있으면 409 로 거부한다. 가드: 본인·마지막 시스템관리자 금지.
dev DB 직결(다른 통합 테스트와 동일).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.comments.models import (
    AuthorRoleSnapshot,
    CommentThread,
    ThreadStatus,
)
from app.modules.embed.models import HtmlEmbedBundle
from app.modules.reports.models import Report
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace
from app.modules.workspaces.services import ensure_personal_workspace

client = TestClient(app)

ADMIN = "hd_admin@hd.test"
TARGET = "hd_target@hd.test"


def _hdr(uid: int) -> dict:
    return {"Authorization": f"Bearer {create_access_token(uid)}"}


def _purge(email: str) -> None:
    """이 email 계정 + 부수 흔적(개인공간·멤버십·임베드·댓글스레드)을 지운다(멱등)."""
    db = SessionLocal()
    try:
        u = db.query(User).filter_by(email=email).one_or_none()
        if u is None:
            return
        personal = f"personal-{u.id}"
        db.query(HtmlEmbedBundle).filter_by(workspace_slug=personal).delete()
        db.query(CommentThread).filter_by(author_user_id=u.id).delete()
        db.query(WorkspaceMember).filter_by(user_id=u.id).delete()
        ws = db.get(Workspace, personal)
        if ws:
            db.delete(ws)
        db.delete(u)
        db.commit()
    finally:
        db.close()


def _mk_admin() -> int:
    db = SessionLocal()
    try:
        u = db.query(User).filter_by(email=ADMIN).one_or_none()
        if u is None:
            u = User(email=ADMIN, name=ADMIN, password_hash="!unused-tests-only")
            db.add(u)
            db.flush()
        u.is_system_admin = True
        u.is_active = True
        db.commit()
        return u.id
    finally:
        db.close()


def _mk_target(*, with_personal=False, org_member=None) -> int:
    db = SessionLocal()
    try:
        u = db.query(User).filter_by(email=TARGET).one_or_none()
        if u is None:
            u = User(email=TARGET, name=TARGET, password_hash="!unused-tests-only")
            db.add(u)
            db.flush()
        if org_member:
            db.add(
                WorkspaceMember(
                    user_id=u.id, workspace_slug=org_member, role=Role.user
                )
            )
        db.commit()
        uid = u.id
        if with_personal:
            ensure_personal_workspace(db, u)
            db.commit()
        return uid
    finally:
        db.close()


@pytest.fixture()
def admin():
    uid = _mk_admin()
    _purge(TARGET)
    yield uid
    _purge(TARGET)


def test_delete_low_footprint_account_frees_email(admin):
    # 부서 멤버십(CASCADE) + 빈 개인공간(CASCADE)만 있는 저흔적 계정 → 삭제 성공.
    uid = _mk_target(with_personal=True, org_member="dev")
    res = client.delete(f"/api/users/{uid}", headers=_hdr(admin))
    assert res.status_code == 200, res.text

    db = SessionLocal()
    try:
        # 계정 사라짐 + 이메일 해방(재가입 가능) + 멤버십·개인공간 CASCADE 정리.
        assert db.get(User, uid) is None
        assert db.query(User).filter_by(email=TARGET).one_or_none() is None
        assert (
            db.query(WorkspaceMember).filter_by(user_id=uid).count() == 0
        )
        assert db.get(Workspace, f"personal-{uid}") is None
    finally:
        db.close()


def test_delete_refused_when_personal_workspace_has_content(admin):
    # 개인공간에 RESTRICT 참조(임베드 번들)가 남으면 CASCADE 가 막히므로 사전 거부.
    uid = _mk_target(with_personal=True)
    db = SessionLocal()
    try:
        db.add(
            HtmlEmbedBundle(
                id="hd-embed-1",
                workspace_slug=f"personal-{uid}",
                owner_user_id=uid,
                entry_path="index.html",
                file_count=1,
                total_bytes=10,
            )
        )
        db.commit()
    finally:
        db.close()

    dep = client.get(f"/api/users/{uid}/dependents", headers=_hdr(admin)).json()["data"]
    assert dep["personal_content"] >= 1, dep
    res = client.delete(f"/api/users/{uid}", headers=_hdr(admin))
    assert res.status_code == 409, res.text
    # 계정은 그대로 살아 있어야 한다.
    db = SessionLocal()
    try:
        assert db.get(User, uid) is not None
    finally:
        db.close()


def test_delete_refused_when_user_authored_comment(admin):
    # 작성한 댓글 스레드(author_user_id RESTRICT)가 있으면 거부. 기존 보고서가
    # 없으면(빈 dev DB) 이 시나리오는 건너뛴다.
    uid = _mk_target()
    db = SessionLocal()
    try:
        report_id = db.execute(select(Report.id).limit(1)).scalar()
        if report_id is None:
            pytest.skip("dev DB 에 보고서가 없어 댓글 RESTRICT 시나리오를 건너뜀")
        db.add(
            CommentThread(
                report_id=report_id,
                page_index=0,
                block_id="blk",
                author_user_id=uid,
                author_role_at_creation=AuthorRoleSnapshot.member,
                status=ThreadStatus.open,
            )
        )
        db.commit()
    finally:
        db.close()

    dep = client.get(f"/api/users/{uid}/dependents", headers=_hdr(admin)).json()["data"]
    assert dep["comment_threads"] >= 1, dep
    res = client.delete(f"/api/users/{uid}", headers=_hdr(admin))
    assert res.status_code == 409, res.text


def test_cannot_delete_self(admin):
    res = client.delete(f"/api/users/{admin}", headers=_hdr(admin))
    assert res.status_code == 400, res.text


def test_delete_requires_system_admin(admin):
    uid = _mk_target()
    res = client.delete(f"/api/users/{uid}", headers=_hdr(uid))  # 비관리자 본인 토큰
    assert res.status_code == 403, res.text
