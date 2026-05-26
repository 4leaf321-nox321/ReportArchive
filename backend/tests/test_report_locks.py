"""End-to-end tests for the report edit-lock + optimistic-revision flow.

Touches the live test DB. Each test creates and tears down its own
report (and any auxiliary user) so the suite can be re-run repeatedly
without leaking rows.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.reports.models import ReportEditLock
from app.modules.users.models import Role, User, WorkspaceMember


ADMIN_WORKSPACE = "dx"


def _admin_headers(workspace: str = ADMIN_WORKSPACE) -> dict[str, str]:
    """Seeded admin (id=1) belongs to dx with admin role; that's the
    primary actor for every test."""
    return {
        "Authorization": f"Bearer {create_access_token(1)}",
        "X-Workspace-Slug": workspace,
    }


def _make_other_user(db) -> int:
    """Inserts (or returns) a second writer in the same workspace so the
    'someone else takes over' case can be exercised. Idempotent: the
    email is fixed so re-runs reuse the same row."""
    user = db.query(User).filter_by(email="lock-other@test.local").one_or_none()
    if user is None:
        user = User(
            email="lock-other@test.local",
            name="Lock 두 번째 편집자",
            password_hash="!unused-tests-only",
        )
        db.add(user)
        db.flush()
    membership = (
        db.query(WorkspaceMember)
        .filter_by(user_id=user.id, workspace_slug=ADMIN_WORKSPACE)
        .one_or_none()
    )
    if membership is None:
        db.add(
            WorkspaceMember(
                user_id=user.id,
                workspace_slug=ADMIN_WORKSPACE,
                role=Role.manager,
            )
        )
    db.commit()
    return user.id


def _other_headers(user_id: int) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {create_access_token(user_id)}",
        "X-Workspace-Slug": ADMIN_WORKSPACE,
    }


def _pick_template(client: TestClient) -> tuple[str, int]:
    res = client.get("/api/templates", headers=_admin_headers())
    assert res.status_code == 200, res.text
    items = res.json()["data"]
    assert items, "Seed must include at least one template"
    return items[0]["template_id"], items[0]["version"]


def _create_report(client: TestClient, *, title: str = "락 테스트") -> dict:
    """Create a report and mount it to ADMIN_WORKSPACE so the rest of
    the lock-test machinery (which uses ADMIN_WORKSPACE for all GET /
    PATCH / lock operations) can see it.

    Phase 1 background: every new report now lands in the creator's
    personal workspace (personal-{user_id}). For tests that exercise
    org-context operations, an explicit mount is required to bridge the
    two — that's exactly what users do via the "조직 게시판에 게시"
    button in the UI. See 협업개선_설계.md §3.1 (mount semantics).
    """
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
    # Mount to the org workspace so the lock-test flow (which calls
    # /api/reports/{id}/lock etc. with X-Workspace-Slug=dx) finds the
    # report visible. Idempotent — mounting is one call regardless of
    # how many tests run.
    mount_res = client.post(
        "/api/mounts",
        headers=_admin_headers(),
        json={"report_id": report["id"], "workspace_slugs": [ADMIN_WORKSPACE]},
    )
    assert mount_res.status_code == 200, mount_res.text
    return report


def _delete_report(client: TestClient, report_id: int) -> None:
    client.delete(f"/api/reports/{report_id}", headers=_admin_headers())


# --------------------------------------------------------------------------- #
# Read-side surface                                                           #
# --------------------------------------------------------------------------- #


def test_fresh_report_starts_with_revision_1_and_no_lock() -> None:
    client = TestClient(app)
    report = _create_report(client)
    try:
        res = client.get(f"/api/reports/{report['id']}", headers=_admin_headers())
        data = res.json()["data"]
        assert data["revision"] == 1
        assert data["edit_lock"] is None
    finally:
        _delete_report(client, report["id"])


# --------------------------------------------------------------------------- #
# Acquire                                                                     #
# --------------------------------------------------------------------------- #


def test_acquire_lock_returns_holder_info_and_appears_on_get() -> None:
    client = TestClient(app)
    report = _create_report(client)
    try:
        acquire = client.post(
            f"/api/reports/{report['id']}/lock", headers=_admin_headers()
        )
        assert acquire.status_code == 200, acquire.text
        info = acquire.json()["data"]
        assert info["user_id"] == 1
        assert info["user_email"] == "admin"

        fresh = client.get(
            f"/api/reports/{report['id']}", headers=_admin_headers()
        ).json()["data"]
        assert fresh["edit_lock"] is not None
        assert fresh["edit_lock"]["user_id"] == 1
    finally:
        _delete_report(client, report["id"])


def test_same_user_can_reacquire_their_own_lock() -> None:
    client = TestClient(app)
    report = _create_report(client)
    try:
        first = client.post(
            f"/api/reports/{report['id']}/lock", headers=_admin_headers()
        ).json()["data"]
        second = client.post(
            f"/api/reports/{report['id']}/lock", headers=_admin_headers()
        )
        assert second.status_code == 200, second.text
        assert second.json()["data"]["acquired_at"] >= first["acquired_at"]
    finally:
        _delete_report(client, report["id"])


def test_other_user_gets_409_with_holder_info() -> None:
    client = TestClient(app)
    db = SessionLocal()
    try:
        other_id = _make_other_user(db)
    finally:
        db.close()

    report = _create_report(client)
    try:
        client.post(
            f"/api/reports/{report['id']}/lock", headers=_admin_headers()
        )
        res = client.post(
            f"/api/reports/{report['id']}/lock",
            headers=_other_headers(other_id),
        )
        assert res.status_code == 409
        detail = res.json()["errors"][0]
        assert detail["code"] == "lock_held_by_other"
        assert detail["holder"]["user_id"] == 1
    finally:
        _delete_report(client, report["id"])


def test_force_takeover_replaces_existing_holder() -> None:
    client = TestClient(app)
    db = SessionLocal()
    try:
        other_id = _make_other_user(db)
    finally:
        db.close()

    report = _create_report(client)
    try:
        client.post(
            f"/api/reports/{report['id']}/lock", headers=_admin_headers()
        )
        res = client.post(
            f"/api/reports/{report['id']}/lock?force=true",
            headers=_other_headers(other_id),
        )
        assert res.status_code == 200, res.text
        assert res.json()["data"]["user_id"] == other_id
        hb = client.post(
            f"/api/reports/{report['id']}/lock/heartbeat",
            headers=_admin_headers(),
        )
        assert hb.status_code == 409
        assert hb.json()["errors"][0]["code"] == "lock_not_held"
    finally:
        _delete_report(client, report["id"])


def test_expired_lock_is_silently_reclaimed() -> None:
    client = TestClient(app)
    db = SessionLocal()
    try:
        other_id = _make_other_user(db)
    finally:
        db.close()

    report = _create_report(client)
    try:
        client.post(
            f"/api/reports/{report['id']}/lock", headers=_admin_headers()
        )
        db = SessionLocal()
        try:
            stale = db.get(ReportEditLock, report["id"])
            stale.expires_at = datetime.utcnow() - timedelta(seconds=1)
            db.commit()
        finally:
            db.close()
        res = client.post(
            f"/api/reports/{report['id']}/lock",
            headers=_other_headers(other_id),
        )
        assert res.status_code == 200, res.text
        assert res.json()["data"]["user_id"] == other_id
    finally:
        _delete_report(client, report["id"])


# --------------------------------------------------------------------------- #
# Heartbeat + release                                                         #
# --------------------------------------------------------------------------- #


def test_heartbeat_extends_expiry() -> None:
    client = TestClient(app)
    report = _create_report(client)
    try:
        acquire = client.post(
            f"/api/reports/{report['id']}/lock", headers=_admin_headers()
        ).json()["data"]
        db = SessionLocal()
        try:
            row = db.get(ReportEditLock, report["id"])
            row.expires_at = datetime.utcnow() + timedelta(seconds=5)
            db.commit()
        finally:
            db.close()
        hb = client.post(
            f"/api/reports/{report['id']}/lock/heartbeat",
            headers=_admin_headers(),
        )
        assert hb.status_code == 200, hb.text
        assert hb.json()["data"]["expires_at"] > acquire["expires_at"]
    finally:
        _delete_report(client, report["id"])


def test_heartbeat_without_lock_returns_409() -> None:
    client = TestClient(app)
    report = _create_report(client)
    try:
        res = client.post(
            f"/api/reports/{report['id']}/lock/heartbeat",
            headers=_admin_headers(),
        )
        assert res.status_code == 409
        assert res.json()["errors"][0]["code"] == "lock_not_held"
    finally:
        _delete_report(client, report["id"])


def test_release_clears_lock_then_is_idempotent() -> None:
    client = TestClient(app)
    report = _create_report(client)
    try:
        client.post(
            f"/api/reports/{report['id']}/lock", headers=_admin_headers()
        )
        first = client.delete(
            f"/api/reports/{report['id']}/lock", headers=_admin_headers()
        )
        assert first.status_code == 200
        second = client.delete(
            f"/api/reports/{report['id']}/lock", headers=_admin_headers()
        )
        assert second.status_code == 200
        fresh = client.get(
            f"/api/reports/{report['id']}", headers=_admin_headers()
        ).json()["data"]
        assert fresh["edit_lock"] is None
    finally:
        _delete_report(client, report["id"])


def test_release_by_non_holder_is_noop() -> None:
    client = TestClient(app)
    db = SessionLocal()
    try:
        other_id = _make_other_user(db)
    finally:
        db.close()

    report = _create_report(client)
    try:
        client.post(
            f"/api/reports/{report['id']}/lock", headers=_admin_headers()
        )
        client.delete(
            f"/api/reports/{report['id']}/lock",
            headers=_other_headers(other_id),
        )
        fresh = client.get(
            f"/api/reports/{report['id']}", headers=_admin_headers()
        ).json()["data"]
        assert fresh["edit_lock"] is not None
        assert fresh["edit_lock"]["user_id"] == 1
    finally:
        _delete_report(client, report["id"])


# --------------------------------------------------------------------------- #
# Update path                                                                 #
# --------------------------------------------------------------------------- #


def test_patch_requires_lock() -> None:
    client = TestClient(app)
    report = _create_report(client)
    try:
        res = client.patch(
            f"/api/reports/{report['id']}",
            headers=_admin_headers(),
            json={"title": "잠긴 적 없는데 저장?"},
        )
        assert res.status_code == 409
        assert res.json()["errors"][0]["code"] == "lock_not_held"
    finally:
        _delete_report(client, report["id"])


def test_patch_succeeds_with_lock_and_bumps_revision() -> None:
    client = TestClient(app)
    report = _create_report(client)
    try:
        client.post(
            f"/api/reports/{report['id']}/lock", headers=_admin_headers()
        )
        res = client.patch(
            f"/api/reports/{report['id']}",
            headers=_admin_headers(),
            json={"title": "수정됨", "expected_revision": 1},
        )
        assert res.status_code == 200, res.text
        data = res.json()["data"]
        assert data["title"] == "수정됨"
        assert data["revision"] == 2
    finally:
        _delete_report(client, report["id"])


def test_patch_with_stale_revision_returns_409() -> None:
    client = TestClient(app)
    report = _create_report(client)
    try:
        client.post(
            f"/api/reports/{report['id']}/lock", headers=_admin_headers()
        )
        ok = client.patch(
            f"/api/reports/{report['id']}",
            headers=_admin_headers(),
            json={"title": "v2", "expected_revision": 1},
        )
        assert ok.status_code == 200
        stale = client.patch(
            f"/api/reports/{report['id']}",
            headers=_admin_headers(),
            json={"title": "stale", "expected_revision": 1},
        )
        assert stale.status_code == 409
        assert stale.json()["errors"][0]["code"] == "revision_mismatch"
    finally:
        _delete_report(client, report["id"])


def test_patch_after_force_takeover_returns_409_for_original_holder() -> None:
    client = TestClient(app)
    db = SessionLocal()
    try:
        other_id = _make_other_user(db)
    finally:
        db.close()

    report = _create_report(client)
    try:
        client.post(
            f"/api/reports/{report['id']}/lock", headers=_admin_headers()
        )
        client.post(
            f"/api/reports/{report['id']}/lock?force=true",
            headers=_other_headers(other_id),
        )
        res = client.patch(
            f"/api/reports/{report['id']}",
            headers=_admin_headers(),
            json={"title": "shouldn't land", "expected_revision": 1},
        )
        assert res.status_code == 409
        assert res.json()["errors"][0]["code"] == "lock_not_held"
    finally:
        _delete_report(client, report["id"])


def test_lock_is_released_via_endpoint_not_on_save() -> None:
    """Saving doesn't auto-release — the frontend handles release on
    save/cancel/leave separately. This pins the contract."""
    client = TestClient(app)
    report = _create_report(client)
    try:
        client.post(
            f"/api/reports/{report['id']}/lock", headers=_admin_headers()
        )
        client.patch(
            f"/api/reports/{report['id']}",
            headers=_admin_headers(),
            json={"title": "still locked after save", "expected_revision": 1},
        )
        fresh = client.get(
            f"/api/reports/{report['id']}", headers=_admin_headers()
        ).json()["data"]
        assert fresh["edit_lock"] is not None
        assert fresh["edit_lock"]["user_id"] == 1
    finally:
        _delete_report(client, report["id"])
