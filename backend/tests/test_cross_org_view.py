"""조직 간 공개(cross-org view) end-to-end 테스트 — 조직간공개_설계.md Phase 1·2.

시나리오: 보고서 R 은 admin(id=1)이 만들어 "dx" 게시판에만 게시(mount)한다.
사용자 B 는 "dev" 게시판 멤버다 — dev 는 dx 의 *자손*(descendant)이라, 가시성은
viewer 워크스페이스의 자손 트리만 훑으므로 dev 멤버에겐 dx-only mount 가 안 보인다
(= 깨끗한 조직 분리). dx 를 공개로 켜면 B 에게 R 이 *공개 경로로만* 보이게 되고,
본문은 열리되 댓글·이력·링크는 막혀야 한다.

라이브 테스트 DB 를 건드린다. 각 테스트가 생성물을 정리하고 dx 공개 토글을
원복하므로 반복 실행해도 행이 새지 않는다.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace

ADMIN_WORKSPACE = "dx"
# dx 의 자손 — 여기 멤버는 dx-only mount 를 (공개 전에는) 못 본다.
OUTSIDER_WORKSPACE = "dev"


def _admin_headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {create_access_token(1)}",
        "X-Workspace-Slug": ADMIN_WORKSPACE,
    }


def _ensure_outsider() -> int:
    """OUTSIDER_WORKSPACE 멤버인 사용자 B 를 보장(멱등). dx 멤버는 아님 —
    멤버십은 위로만 걸어가므로 자손 게시판 멤버는 조상(dx)에 접근 못 한다."""
    db = SessionLocal()
    try:
        user = (
            db.query(User).filter_by(email="cross-org-outsider@test.local").one_or_none()
        )
        if user is None:
            user = User(
                email="cross-org-outsider@test.local",
                name="외부 조직 열람자",
                password_hash="!unused-tests-only",
            )
            db.add(user)
            db.flush()
        member = (
            db.query(WorkspaceMember)
            .filter_by(user_id=user.id, workspace_slug=OUTSIDER_WORKSPACE)
            .one_or_none()
        )
        if member is None:
            db.add(
                WorkspaceMember(
                    user_id=user.id,
                    workspace_slug=OUTSIDER_WORKSPACE,
                    role=Role.user,
                )
            )
        db.commit()
        return user.id
    finally:
        db.close()


def _outsider_headers(user_id: int) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {create_access_token(user_id)}",
        "X-Workspace-Slug": OUTSIDER_WORKSPACE,
    }


def _set_dx_public(public: bool) -> None:
    db = SessionLocal()
    try:
        ws = db.get(Workspace, ADMIN_WORKSPACE)
        ws.external_view_default = public
        db.commit()
    finally:
        db.close()


def _pick_template(client: TestClient) -> tuple[str, int]:
    res = client.get("/api/templates", headers=_admin_headers())
    assert res.status_code == 200, res.text
    items = res.json()["data"]
    assert items, "Seed must include at least one template"
    return items[0]["template_id"], items[0]["version"]


def _create_mounted_report(client: TestClient, *, title: str = "공개 테스트") -> dict:
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


def _delete_report(client: TestClient, report_id: int) -> None:
    client.delete(f"/api/reports/{report_id}", headers=_admin_headers())


# --------------------------------------------------------------------------- #
# Phase 1 — 읽기 가시성                                                        #
# --------------------------------------------------------------------------- #


def test_outsider_cannot_see_private_mount() -> None:
    """공개 끄면 dx-only 보고서는 dev 멤버에게 403."""
    client = TestClient(app)
    outsider = _ensure_outsider()
    report = _create_mounted_report(client)
    _set_dx_public(False)
    try:
        res = client.get(
            f"/api/reports/{report['id']}", headers=_outsider_headers(outsider)
        )
        assert res.status_code == 403, res.text
    finally:
        _delete_report(client, report["id"])


def test_outsider_can_read_public_mount_as_readonly() -> None:
    """dx 를 공개로 켜면 dev 멤버가 본문을 200 으로 보되, 읽기전용 플래그가 선다."""
    client = TestClient(app)
    outsider = _ensure_outsider()
    report = _create_mounted_report(client)
    _set_dx_public(True)
    try:
        res = client.get(
            f"/api/reports/{report['id']}", headers=_outsider_headers(outsider)
        )
        assert res.status_code == 200, res.text
        data = res.json()["data"]
        assert data["is_public_view"] is True
        assert data["can_comment"] is False
        assert data["can_edit"] is False
    finally:
        _set_dx_public(False)
        _delete_report(client, report["id"])


def test_member_view_is_not_public_readonly() -> None:
    """같은 보고서를 dx 멤버(admin)가 보면 공개전용 플래그가 서지 않는다."""
    client = TestClient(app)
    report = _create_mounted_report(client)
    _set_dx_public(True)
    try:
        res = client.get(f"/api/reports/{report['id']}", headers=_admin_headers())
        assert res.status_code == 200, res.text
        data = res.json()["data"]
        assert data["is_public_view"] is False
        assert data["can_comment"] is True
    finally:
        _set_dx_public(False)
        _delete_report(client, report["id"])


# --------------------------------------------------------------------------- #
# Phase 2 — 곁다리 차단                                                        #
# --------------------------------------------------------------------------- #


def test_public_viewer_comments_hidden_and_blocked() -> None:
    client = TestClient(app)
    outsider = _ensure_outsider()
    report = _create_mounted_report(client)
    rid = report["id"]
    _set_dx_public(True)
    try:
        h = _outsider_headers(outsider)
        # 조회: 숨김(빈 목록)
        listed = client.get(f"/api/reports/{rid}/threads", headers=h)
        assert listed.status_code == 200, listed.text
        assert listed.json()["data"]["items"] == []
        # 작성: 403
        created = client.post(
            f"/api/reports/{rid}/threads",
            headers=h,
            json={
                "page_index": 0,
                "block_id": "block-1",
                "body": {"type": "doc", "content": []},
            },
        )
        assert created.status_code == 403, created.text
    finally:
        _set_dx_public(False)
        _delete_report(client, rid)


def test_public_viewer_activities_hidden() -> None:
    client = TestClient(app)
    outsider = _ensure_outsider()
    report = _create_mounted_report(client)
    rid = report["id"]
    _set_dx_public(True)
    try:
        res = client.get(
            f"/api/reports/{rid}/activities", headers=_outsider_headers(outsider)
        )
        assert res.status_code == 200, res.text
        assert res.json()["data"]["items"] == []
    finally:
        _set_dx_public(False)
        _delete_report(client, rid)


def test_public_viewer_cannot_add_link() -> None:
    client = TestClient(app)
    outsider = _ensure_outsider()
    report = _create_mounted_report(client)
    rid = report["id"]
    _set_dx_public(True)
    try:
        res = client.post(
            f"/api/reports/{rid}/links",
            headers=_outsider_headers(outsider),
            json={"to_report_id": rid, "kind": "related", "direction": "outgoing"},
        )
        assert res.status_code == 403, res.text
    finally:
        _set_dx_public(False)
        _delete_report(client, rid)
