"""Integration test for GET /api/widgets.

Exercises the live FastAPI app + auth pipeline so we know the catalog is
actually reachable from the frontend and isn't accidentally gated by
workspace context (it should only need authentication).
"""
from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token


def _token_for_seeded_admin() -> str:
    """The seed creates user id=1 (login id "admin"). Tests assume seed
    has run; if not, this token is still valid JWT-wise but the endpoint
    will 401 on the user lookup."""
    return create_access_token(1)


def test_widgets_endpoint_returns_full_catalog() -> None:
    client = TestClient(app)
    res = client.get(
        "/api/widgets",
        headers={"Authorization": f"Bearer {_token_for_seeded_admin()}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["success"] is True
    data = body["data"]
    assert data["schema_version"] == "widget-v1"
    types = sorted(w["type"] for w in data["widgets"])
    assert types == sorted(
        [
            "heading", "rich_text", "key_value", "bulleted_list",
            "table", "kpi_card", "image", "attachment", "chart",
        ]
    )
    # Each entry must include the fields the frontend needs to build a
    # palette + props panel.
    for w in data["widgets"]:
        assert {"type", "label", "description", "has_content", "props_schema", "default_props"} <= set(w)


def test_widgets_endpoint_requires_auth() -> None:
    client = TestClient(app)
    res = client.get("/api/widgets")
    assert res.status_code in (401, 403)
