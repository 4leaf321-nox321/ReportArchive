"""공유/권한 개편 — 보고서 가시성·읽기전용·shares API end-to-end.

새 정책: **하위 상속, 상위 자동 열람 없음.** 부서에 공유하면 그 부서와 하위
부서가 보고, 전체 공개(all_org)는 사내 누구나 읽기전용. 공유 추가/삭제는
소유자(또는 시스템관리자)만.

트리: dx(루트) → division-mx → dev → ... 즉 dev 는 dx 의 하위.
라이브 테스트 DB 를 쓰며, 각 테스트가 생성물(보고서·grant)을 정리한다.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.users.models import Role, User, WorkspaceMember

ADMIN_WORKSPACE = "dx"      # 루트
CHILD_WORKSPACE = "dev"     # dx 의 하위


def _admin_headers(ws: str = ADMIN_WORKSPACE) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {create_access_token(1)}",
        "X-Workspace-Slug": ws,
    }


def _ensure_user(email: str, ws: str | None) -> int:
    """이메일로 사용자 보장(멱등). ws 가 주어지면 그 부서 멤버로(없으면 무소속)."""
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(email=email).one_or_none()
        if user is None:
            user = User(email=email, name=email, password_hash="!unused-tests-only")
            db.add(user)
            db.flush()
        if ws is not None:
            m = (
                db.query(WorkspaceMember)
                .filter_by(user_id=user.id, workspace_slug=ws)
                .one_or_none()
            )
            if m is None:
                db.add(
                    WorkspaceMember(user_id=user.id, workspace_slug=ws, role=Role.user)
                )
        db.commit()
        return user.id
    finally:
        db.close()


def _headers(user_id: int, ws: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {create_access_token(user_id)}",
        "X-Workspace-Slug": ws,
    }


def _pick_template(client: TestClient) -> tuple[str, int]:
    res = client.get("/api/templates", headers=_admin_headers())
    assert res.status_code == 200, res.text
    items = res.json()["data"]
    assert items, "Seed must include at least one template"
    return items[0]["template_id"], items[0]["version"]


def _create_mounted_report(client: TestClient, *, title: str = "공유 테스트") -> dict:
    """admin 이 보고서 생성 + dx 게시(mount). mount 가 dx view grant 를 자동 생성."""
    template_id, version = _pick_template(client)
    res = client.post(
        "/api/reports",
        headers=_admin_headers(),
        json={
            "template_id": template_id,
            "template_version": version,
            "title": title,
            "tags": [],
        },
    )
    assert res.status_code == 201, res.text
    report = res.json()["data"]
    mount = client.post(
        "/api/mounts",
        headers=_admin_headers(),
        json={"report_id": report["id"], "workspace_slugs": [ADMIN_WORKSPACE]},
    )
    assert mount.status_code == 200, mount.text
    return report


def _add_all_org(client: TestClient, rid: int) -> None:
    res = client.post(
        f"/api/reports/{rid}/shares",
        headers=_admin_headers(),
        json={"principal_type": "all_org"},
    )
    assert res.status_code == 201, res.text


def _clear_shares(client: TestClient, rid: int) -> None:
    got = client.get(f"/api/reports/{rid}/shares", headers=_admin_headers())
    if got.status_code != 200:
        return
    for g in got.json()["data"]:
        client.delete(
            f"/api/reports/{rid}/shares/{g['id']}", headers=_admin_headers()
        )


def _delete_report(client: TestClient, report_id: int) -> None:
    client.delete(f"/api/reports/{report_id}", headers=_admin_headers())


# --------------------------------------------------------------------------- #
# 하위 상속 (downward)
# --------------------------------------------------------------------------- #
def test_child_member_sees_parent_mount() -> None:
    """dx 에 게시된 보고서를 하위 부서 dev 멤버가 *멤버 경로*로 본다(하위 상속).
    공개(all_org) 없이도 보임 — is_public_view False."""
    client = TestClient(app)
    child_uid = _ensure_user("share-child@test.local", CHILD_WORKSPACE)
    report = _create_mounted_report(client)
    try:
        res = client.get(
            f"/api/reports/{report['id']}",
            headers=_headers(child_uid, CHILD_WORKSPACE),
        )
        assert res.status_code == 200, res.text
        assert res.json()["data"]["is_public_view"] is False
    finally:
        _delete_report(client, report["id"])


# --------------------------------------------------------------------------- #
# 전체 공개(all_org) — 비멤버 읽기전용 + 곁다리 차단
# --------------------------------------------------------------------------- #
def test_nonmember_denied_without_public() -> None:
    """무소속 사용자는 공개 없으면 dx 진입/열람 불가(403)."""
    client = TestClient(app)
    outsider = _ensure_user("share-outsider@test.local", None)
    report = _create_mounted_report(client)
    try:
        res = client.get(
            f"/api/reports/{report['id']}",
            headers=_headers(outsider, ADMIN_WORKSPACE),
        )
        assert res.status_code == 403, res.text
    finally:
        _delete_report(client, report["id"])


def test_nonmember_reads_all_org_readonly() -> None:
    """all_org 공유하면 무소속 사용자가 본문을 200 으로 보되 읽기전용 + 곁다리 차단."""
    client = TestClient(app)
    outsider = _ensure_user("share-outsider@test.local", None)
    report = _create_mounted_report(client)
    rid = report["id"]
    _add_all_org(client, rid)
    try:
        h = _headers(outsider, ADMIN_WORKSPACE)
        res = client.get(f"/api/reports/{rid}", headers=h)
        assert res.status_code == 200, res.text
        data = res.json()["data"]
        assert data["is_public_view"] is True
        assert data["can_comment"] is False
        assert data["can_edit"] is False
        # 댓글 숨김 + 작성 403
        listed = client.get(f"/api/reports/{rid}/threads", headers=h)
        assert listed.status_code == 200 and listed.json()["data"]["items"] == []
        created = client.post(
            f"/api/reports/{rid}/threads",
            headers=h,
            json={
                "page_index": 0,
                "block_id": "b1",
                "body": {"type": "doc", "content": []},
            },
        )
        assert created.status_code == 403, created.text
        # 이력 숨김
        acts = client.get(f"/api/reports/{rid}/activities", headers=h)
        assert acts.status_code == 200 and acts.json()["data"]["items"] == []
        # 링크 추가 403
        link = client.post(
            f"/api/reports/{rid}/links",
            headers=h,
            json={"to_report_id": rid, "kind": "related", "direction": "outgoing"},
        )
        assert link.status_code == 403, link.text
    finally:
        _clear_shares(client, rid)
        _delete_report(client, rid)


def test_remove_all_org_revokes_access() -> None:
    """all_org 공유를 제거하면 무소속 사용자는 다시 403."""
    client = TestClient(app)
    outsider = _ensure_user("share-outsider@test.local", None)
    report = _create_mounted_report(client)
    rid = report["id"]
    _add_all_org(client, rid)
    try:
        h = _headers(outsider, ADMIN_WORKSPACE)
        assert client.get(f"/api/reports/{rid}", headers=h).status_code == 200
        _clear_shares(client, rid)
        # mount 의 dx grant 는 남지만 outsider 는 dx 멤버가 아님 → 403.
        assert client.get(f"/api/reports/{rid}", headers=h).status_code == 403
    finally:
        _clear_shares(client, rid)
        _delete_report(client, rid)


# --------------------------------------------------------------------------- #
# shares API 권한 — 소유자/시스템관리자만 추가
# --------------------------------------------------------------------------- #
def test_shares_add_owner_only() -> None:
    """소유자가 아닌 멤버는 공유 추가 403."""
    client = TestClient(app)
    child_uid = _ensure_user("share-child@test.local", CHILD_WORKSPACE)
    report = _create_mounted_report(client)  # owner = admin
    rid = report["id"]
    try:
        denied = client.post(
            f"/api/reports/{rid}/shares",
            headers=_headers(child_uid, CHILD_WORKSPACE),
            json={"principal_type": "all_org"},
        )
        assert denied.status_code == 403, denied.text
    finally:
        _clear_shares(client, rid)
        _delete_report(client, rid)
