"""Integration tests for the widget_relations CRUD endpoints.

Touches the live DB. Custom relations created here are cleaned up at the
end of each test so the table stays in the same state as the seed.
"""
from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token


def _admin_headers():
    token = create_access_token(2)  # seeded admin
    return {"Authorization": f"Bearer {token}", "X-Workspace-Slug": "dev"}


def test_list_returns_seeded_builtins():
    client = TestClient(app)
    res = client.get("/api/widget-relations", headers=_admin_headers())
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    slugs = {r["slug"] for r in data}
    # The migration seeds these 7.
    assert {"detail", "cause", "effect", "evidence", "example", "counter", "compare"} <= slugs
    # Built-ins flagged.
    detail = next(r for r in data if r["slug"] == "detail")
    assert detail["is_builtin"] is True
    assert detail["name"] == "상세"


def test_create_then_delete_custom_relation():
    client = TestClient(app)
    payload = {
        "slug": "test-hypothesis",
        "name": "가설",
        "description": "검증 대상 가정",
        "hint_keywords": ["가정하면", "만약"],
        "sort_order": 999,
    }
    create = client.post(
        "/api/widget-relations", json=payload, headers=_admin_headers()
    )
    try:
        assert create.status_code == 201, create.text
        created = create.json()["data"]
        assert created["slug"] == "test-hypothesis"
        assert created["is_builtin"] is False
        assert created["hint_keywords"] == ["가정하면", "만약"]
    finally:
        delete = client.delete(
            f"/api/widget-relations/{payload['slug']}", headers=_admin_headers()
        )
        assert delete.status_code == 200


def test_cannot_delete_builtin():
    client = TestClient(app)
    res = client.delete("/api/widget-relations/detail", headers=_admin_headers())
    assert res.status_code == 400
    assert "빌트인" in res.text


def test_update_renames_builtin():
    """Built-ins can't be deleted, but their display name / hints can be
    edited. Restore the original name after the test."""
    client = TestClient(app)
    original = client.get("/api/widget-relations", headers=_admin_headers()).json()["data"]
    detail = next(r for r in original if r["slug"] == "detail")
    try:
        patch = client.patch(
            "/api/widget-relations/detail",
            json={"name": "세부 (테스트)"},
            headers=_admin_headers(),
        )
        assert patch.status_code == 200
        assert patch.json()["data"]["name"] == "세부 (테스트)"
    finally:
        client.patch(
            "/api/widget-relations/detail",
            json={"name": detail["name"]},
            headers=_admin_headers(),
        )


def test_create_rejects_duplicate_slug():
    client = TestClient(app)
    res = client.post(
        "/api/widget-relations",
        json={"slug": "cause", "name": "X"},
        headers=_admin_headers(),
    )
    assert res.status_code == 400


def test_list_is_public_to_authenticated_user():
    """Non-admin users can read relations (they need them in the editor)."""
    client = TestClient(app)
    # seeded non-admin = user id 1 (per existing test fixtures pattern).
    token = create_access_token(1)
    headers = {"Authorization": f"Bearer {token}", "X-Workspace-Slug": "dev"}
    res = client.get("/api/widget-relations", headers=headers)
    assert res.status_code == 200
