"""영구삭제(purge) 권한·가드 — 보고서 삭제 재설계 3단계.

DELETE /api/reports/{id} 는 비가역 영구삭제(원본·게시·종합보고 안건 cascade).
  - 권한: 소유자 / 시스템관리자만 (게시판 매니저는 자기 board 게시취소로 다룸).
  - 게시 중이면 차단(409) — 게시취소(해제/내리기 요청 승인)로 mount 가 0이
    된 뒤에만 영구삭제할 수 있다.
평소 "삭제"는 이게 아니라 소프트삭제(/trash) — test_report_soft_delete 참고.
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


def _purge(rid):
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        if r:
            db.delete(r)
            db.commit()
    finally:
        db.close()


def _make_mounted_report(client):
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    rid = client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "영구삭제 테스트",
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
    """게시판 매니저는 True, 일반 멤버는 False (게시취소 권한 판정용)."""
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
        _purge(rid)


def test_purge_blocked_while_mounted_then_allowed():
    """게시 중이면 영구삭제 409, 게시취소 후 200."""
    client = TestClient(app)
    rid = _make_mounted_report(client)
    purged = False
    try:
        # 게시 중 → 차단.
        r = client.delete(f"/api/reports/{rid}", headers=_h())
        assert r.status_code == 409, r.text

        # 게시취소(시스템관리자) 후 → 영구삭제 허용.
        assert (
            client.delete(f"/api/mounts/{rid}/{BOARD}", headers=_h()).status_code == 200
        )
        r = client.delete(f"/api/reports/{rid}", headers=_h())
        assert r.status_code == 200, r.text
        purged = True
        # 정말 사라졌는지.
        assert client.get(f"/api/reports/{rid}", headers=_h()).status_code == 404
    finally:
        if not purged:
            _purge(rid)


def test_purge_forbidden_for_non_owner_board_manager():
    """소유자도 시스템관리자도 아닌 게시판 매니저는 영구삭제 403."""
    client = TestClient(app)
    mgr = _ensure_member("del-mgr@test.local", BOARD, Role.manager)
    rid = _make_mounted_report(client)
    try:
        r = client.delete(f"/api/reports/{rid}", headers=_h(mgr, BOARD))
        assert r.status_code == 403, r.text
    finally:
        _purge(rid)


def test_read_response_exposes_purge_flags():
    """ReportRead.can_purge/is_mounted — 게시 중이면 can_purge False."""
    client = TestClient(app)
    rid = _make_mounted_report(client)
    try:
        obj = client.get(f"/api/reports/{rid}", headers=_h()).json()["data"]
        assert obj.get("is_mounted") is True
        assert obj.get("can_purge") is False  # 게시 중이라 불가
    finally:
        _purge(rid)
