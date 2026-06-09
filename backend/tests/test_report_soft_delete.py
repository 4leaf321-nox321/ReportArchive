"""소프트삭제(휴지통) 1단계 — 보고서 삭제 재설계.

"삭제"(/trash)는 즉시 파괴가 아니라 deleted_at set:
  - 작성자 개인 목록/검색에서 숨김(휴지통).
  - 게시된 부서 게시판에는 그대로 남음(게시분 보존).
  - 복구(/restore) 가능. 권한은 소유자/시스템관리자.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
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
    """테스트 정리는 하드 삭제(소프트삭제 잔여가 공유 DB·board 목록을 오염시키지
    않게)."""
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
    res = client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "소프트삭제 테스트",
            "tags": [],
        },
    ).json()["data"]
    rid, personal_slug = res["id"], res["workspace_slug"]
    client.post(
        "/api/mounts",
        headers=_h(),
        json={"report_id": rid, "workspace_slugs": [BOARD]},
    )
    return rid, personal_slug


def _ids_on(client, slug, **params):
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"/api/reports?{qs}" if qs else "/api/reports"
    return {r["id"] for r in client.get(url, headers=_h(1, slug)).json()["data"]}


def test_soft_delete_hides_personal_keeps_board_then_restore():
    client = TestClient(app)
    rid, personal = _make_mounted_report(client)
    try:
        # 삭제 전 — 개인 목록에 있음.
        assert rid in _ids_on(client, personal)

        # 소프트삭제.
        r = client.post(f"/api/reports/{rid}/trash", headers=_h())
        assert r.status_code == 200, r.text

        # 개인 목록에선 숨고, 게시판(BOARD)엔 그대로, 휴지통엔 보임.
        assert rid not in _ids_on(client, personal)
        assert rid in _ids_on(client, BOARD)
        assert rid in _ids_on(client, personal, trashed="true")

        # deleted_at 이 채워지고 can_trash True.
        obj = client.get(f"/api/reports/{rid}", headers=_h()).json()["data"]
        assert obj.get("deleted_at") is not None
        assert obj.get("can_trash") is True

        # 복구 — 다시 개인 목록에 보이고 휴지통에서 사라짐.
        r = client.post(f"/api/reports/{rid}/restore", headers=_h())
        assert r.status_code == 200, r.text
        assert rid in _ids_on(client, personal)
        assert rid not in _ids_on(client, personal, trashed="true")
    finally:
        _purge(rid)


def test_trash_forbidden_for_non_owner():
    client = TestClient(app)
    member = _ensure_member("trash-member@test.local", BOARD, Role.user)
    rid, _ = _make_mounted_report(client)
    try:
        # 소유자도 시스템관리자도 아닌 부서 멤버 → 휴지통 403.
        r = client.post(f"/api/reports/{rid}/trash", headers=_h(member, BOARD))
        assert r.status_code == 403, r.text
    finally:
        _purge(rid)
