"""삭제 권한 한정 — 소유자 / 시스템관리자 / 게시판 매니저만.

기존 버그: 삭제가 can_read(조회 가능) 기준이라 열람자도 지울 수 있었다.
이제 can_delete_report 로 좁혔다(coauthor·추가편집자 같은 편집권자도 삭제 불가).
삭제는 게시된 모든 부서에서 cascade 로 사라지는 파괴적 작업이라.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.reports import services as rs
from app.modules.reports.models import Report
from app.modules.users.models import Role, User, WorkspaceMember

BOARD = "dev-hw"


def _ensure_member(email, slug, role):
    db = SessionLocal()
    try:
        u = db.query(User).filter_by(email=email).one_or_none()
        if u is None:
            u = User(email=email, name=email, password_hash="!unused-tests-only")
            db.add(u)
            db.flush()
        m = (
            db.query(WorkspaceMember)
            .filter_by(user_id=u.id, workspace_slug=slug)
            .one_or_none()
        )
        if m is None:
            db.add(WorkspaceMember(user_id=u.id, workspace_slug=slug, role=role))
        else:
            m.role = role
        db.commit()
        return u.id
    finally:
        db.close()


def _h(uid=1, slug="dx"):
    return {"Authorization": f"Bearer {create_access_token(uid)}", "X-Workspace-Slug": slug}


def _make_mounted_report(client):
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    rid = client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "삭제권한 테스트",
            "tags": [],
        },
    ).json()["data"]["id"]
    client.post(
        "/api/mounts",
        headers=_h(),
        json={"report_id": rid, "workspace_slugs": [BOARD]},
    )
    return rid


def test_is_report_board_manager():
    """게시판 매니저는 True, 일반 멤버는 False."""
    client = TestClient(app)
    mgr = _ensure_member("del-mgr@test.local", BOARD, Role.manager)
    member = _ensure_member("del-member@test.local", BOARD, Role.user)
    rid = _make_mounted_report(client)
    try:
        db = SessionLocal()
        try:
            report = db.get(Report, rid)
            assert rs.is_report_board_manager(db, mgr, report) is True
            assert rs.is_report_board_manager(db, member, report) is False
        finally:
            db.close()
    finally:
        client.delete(f"/api/reports/{rid}", headers=_h())


def test_delete_blocked_for_plain_member_allowed_for_board_manager():
    """일반 부서 멤버(소유자도 매니저도 아님)는 삭제 403, 게시판 매니저는 200."""
    client = TestClient(app)
    mgr = _ensure_member("del-mgr@test.local", BOARD, Role.manager)
    member = _ensure_member("del-member@test.local", BOARD, Role.user)
    rid = _make_mounted_report(client)

    # 일반 멤버 → 403 (writer 역할이지만 소유자/매니저 아님)
    r = client.delete(f"/api/reports/{rid}", headers=_h(member, BOARD))
    assert r.status_code == 403, r.text

    # 게시판 매니저 → 200 (삭제 성공)
    r = client.delete(f"/api/reports/{rid}", headers=_h(mgr, BOARD))
    assert r.status_code == 200, r.text


def test_delete_allowed_for_owner():
    """소유자(겸 작성자)는 삭제 가능."""
    client = TestClient(app)
    rid = _make_mounted_report(client)
    r = client.delete(f"/api/reports/{rid}", headers=_h())
    assert r.status_code == 200, r.text


def test_read_response_exposes_can_delete():
    """ReportRead.can_delete 가 응답에 실린다(프런트 버튼 게이팅용)."""
    client = TestClient(app)
    rid = _make_mounted_report(client)
    try:
        obj = client.get(f"/api/reports/{rid}", headers=_h()).json()["data"]
        assert obj.get("can_delete") is True  # 소유자
    finally:
        client.delete(f"/api/reports/{rid}", headers=_h())
