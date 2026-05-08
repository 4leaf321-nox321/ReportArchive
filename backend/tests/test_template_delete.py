"""Integration tests for DELETE /api/templates/{id}.

Covers:
  - admin can delete a template with no reports
  - 409 when reports reference the template
  - non-admin (manager) gets 403
  - 404 for unknown template_id
"""
import io
import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.templates.models import Template
from app.modules.reports.models import Report


def _admin_headers():
    return {
        "Authorization": f"Bearer {create_access_token(2)}",  # seeded admin
        "X-Workspace-Slug": "dev",
    }


def _manager_headers():
    return {
        "Authorization": f"Bearer {create_access_token(3)}",  # seeded manager
        "X-Workspace-Slug": "dev-platform",
    }


def _seed_template(slugs=None) -> str:
    db = SessionLocal()
    tid = f"del-{uuid.uuid4().hex[:8]}"
    db.add(
        Template(
            template_id=tid,
            version=1,
            name="t",
            description="",
            category="misc",
            schema={
                "version": "widget-v1",
                "blocks": [
                    {"id": "summary", "type": "rich_text", "props": {"label": "요약"}},
                ],
            },
            owner_workspace_slugs=slugs,
            is_published=True,
            is_latest=True,
            created_by_user_id=2,
        )
    )
    db.commit()
    db.close()
    return tid


def _force_delete(template_id: str):
    """Cleanup helper for tests that don't successfully delete via API."""
    db = SessionLocal()
    db.query(Report).filter(Report.template_id == template_id).delete()
    db.query(Template).filter(Template.template_id == template_id).delete()
    db.commit()
    db.close()


def test_admin_can_delete_template_without_reports():
    client = TestClient(app)
    tid = _seed_template()
    try:
        res = client.delete(f"/api/templates/{tid}", headers=_admin_headers())
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["success"] is True
        assert body["data"]["deleted_versions"] == 1
        # Verify it's actually gone
        res2 = client.get(f"/api/templates/{tid}", headers=_admin_headers())
        assert res2.status_code == 404
    finally:
        _force_delete(tid)


def test_delete_refuses_when_reports_reference_template():
    client = TestClient(app)
    tid = _seed_template()
    db = SessionLocal()
    db.add(
        Report(
            workspace_slug="dev",
            template_id=tid,
            template_version=1,
            title="ref",
            content={},
            owner_user_id=2,
        )
    )
    db.commit()
    db.close()
    try:
        res = client.delete(f"/api/templates/{tid}", headers=_admin_headers())
        assert res.status_code == 409, res.text
        assert "보고서" in res.json()["message"]
    finally:
        _force_delete(tid)


def test_delete_requires_admin():
    client = TestClient(app)
    tid = _seed_template()
    try:
        res = client.delete(f"/api/templates/{tid}", headers=_manager_headers())
        assert res.status_code == 403, res.text
    finally:
        _force_delete(tid)


def test_delete_unknown_template_returns_404():
    client = TestClient(app)
    res = client.delete("/api/templates/no-such-template", headers=_admin_headers())
    assert res.status_code == 404
