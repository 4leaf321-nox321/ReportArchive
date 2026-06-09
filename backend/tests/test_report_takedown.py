"""게시판별 게시취소 요청 큐 — 보고서 삭제 재설계 2단계.

작성자가 "게시판에서 내리기"를 요청하면 게시된 board 마다 팬아웃:
  - 요청자가 관리하는 board → 즉시 게시취소(auto_removed)
  - 그 외 board → pending 요청, 그 board 매니저가 승인(게시취소)/거절(유지)
복구(휴지통)하면 진행 중 요청이 자동 철회된다.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.reports.models import Report
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.services import ensure_personal_workspace

BOARD = "dev-hw"


def _ensure_member(email, slug, role):
    db = SessionLocal()
    try:
        u = db.query(User).filter_by(email=email).one_or_none()
        if u is None:
            u = User(email=email, name=email, password_hash="!unused-tests-only")
            db.add(u)
            db.flush()
        # 보고서는 personal-{uid} 공간에 태어나므로 개인 워크스페이스가 있어야
        # 한다(가입 훅이 하는 일 — 테스트는 직접 보장).
        ensure_personal_workspace(db, u)
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


def _h(uid, slug=BOARD):
    return {"Authorization": f"Bearer {create_access_token(uid)}", "X-Workspace-Slug": slug}


def _purge(rid):
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        if r:
            db.delete(r)  # cascade → mounts + takedown requests
            db.commit()
    finally:
        db.close()


def _make_report_mounted_by(owner_uid):
    """owner_uid 가 작성·게시한 보고서(BOARD 에 mount)."""
    client = TestClient(app)
    h = _h(owner_uid)
    tpl = client.get("/api/templates", headers=h).json()["data"][0]
    rid = client.post(
        "/api/reports",
        headers=h,
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "게시취소요청 테스트",
            "tags": [],
        },
    ).json()["data"]["id"]
    client.post(
        "/api/mounts",
        headers=h,
        json={"report_id": rid, "workspace_slugs": [BOARD]},
    )
    return rid


def _mount_slugs(client, rid, headers):
    return {
        m["workspace_slug"]
        for m in client.get(f"/api/mounts?report_id={rid}", headers=headers)
        .json()["data"]["items"]
    }


def test_non_manager_owner_request_then_manager_approve():
    client = TestClient(app)
    owner = _ensure_member("td-owner@test.local", BOARD, Role.user)
    mgr = _ensure_member("td-mgr@test.local", BOARD, Role.manager)
    member = _ensure_member("td-member@test.local", BOARD, Role.user)
    rid = _make_report_mounted_by(owner)
    try:
        # 작성자(매니저 아님)가 요청 → pending 1건(직접 못 내림).
        r = client.post(f"/api/reports/{rid}/takedown-requests", headers=_h(owner))
        assert r.status_code == 200, r.text
        assert r.json()["data"] == {"requested": 1, "auto_removed": 0}
        # 아직 게시판엔 그대로.
        assert BOARD in _mount_slugs(client, rid, _h(mgr))

        # 일반 멤버는 큐 조회 불가(403).
        assert client.get("/api/takedown-requests", headers=_h(member)).status_code == 403

        # 매니저 큐에 보임.
        rows = client.get("/api/takedown-requests", headers=_h(mgr)).json()["data"]
        mine = [x for x in rows if x["report_id"] == rid]
        assert len(mine) == 1 and mine[0]["status"] == "pending"

        # 매니저 승인 → 게시취소됨.
        req_id = mine[0]["id"]
        r = client.post(f"/api/takedown-requests/{req_id}/approve", headers=_h(mgr))
        assert r.status_code == 200, r.text
        assert BOARD not in _mount_slugs(client, rid, _h(mgr))
    finally:
        _purge(rid)


def test_manager_reject_keeps_mount():
    client = TestClient(app)
    owner = _ensure_member("td-owner2@test.local", BOARD, Role.user)
    mgr = _ensure_member("td-mgr@test.local", BOARD, Role.manager)
    rid = _make_report_mounted_by(owner)
    try:
        client.post(f"/api/reports/{rid}/takedown-requests", headers=_h(owner))
        rows = client.get("/api/takedown-requests", headers=_h(mgr)).json()["data"]
        req_id = [x for x in rows if x["report_id"] == rid][0]["id"]
        r = client.post(f"/api/takedown-requests/{req_id}/reject", headers=_h(mgr))
        assert r.status_code == 200, r.text
        # 거절 → 게시 유지.
        assert BOARD in _mount_slugs(client, rid, _h(mgr))
        # 큐에서 사라짐(pending 아님).
        rows2 = client.get("/api/takedown-requests", headers=_h(mgr)).json()["data"]
        assert all(x["report_id"] != rid for x in rows2)
    finally:
        _purge(rid)


def test_manager_owner_request_auto_removes():
    """작성자가 그 board 의 매니저면 요청 즉시 게시취소(auto_removed)."""
    client = TestClient(app)
    mgr_owner = _ensure_member("td-mgrowner@test.local", BOARD, Role.manager)
    rid = _make_report_mounted_by(mgr_owner)
    try:
        r = client.post(f"/api/reports/{rid}/takedown-requests", headers=_h(mgr_owner))
        assert r.status_code == 200, r.text
        assert r.json()["data"] == {"requested": 0, "auto_removed": 1}
        assert BOARD not in _mount_slugs(client, rid, _h(mgr_owner))
    finally:
        _purge(rid)


def test_restore_cancels_pending_requests():
    client = TestClient(app)
    owner = _ensure_member("td-owner3@test.local", BOARD, Role.user)
    mgr = _ensure_member("td-mgr@test.local", BOARD, Role.manager)
    rid = _make_report_mounted_by(owner)
    try:
        client.post(f"/api/reports/{rid}/takedown-requests", headers=_h(owner))
        # 휴지통 → 복구하면 진행 중 요청 자동 철회.
        assert client.post(f"/api/reports/{rid}/trash", headers=_h(owner)).status_code == 200
        assert client.post(f"/api/reports/{rid}/restore", headers=_h(owner)).status_code == 200
        rows = client.get("/api/takedown-requests", headers=_h(mgr)).json()["data"]
        assert all(x["report_id"] != rid for x in rows)  # pending 없음
    finally:
        _purge(rid)
