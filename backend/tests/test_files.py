"""Integration tests for the file upload/download/meta/delete endpoints.

Touches the live DB and writes to settings.upload_dir_path. Each test
cleans up the file it creates so the upload dir doesn't grow over time.
"""
import io

from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token


def _admin_headers():
    # Seeded admin: id=2, dev workspace.
    token = create_access_token(2)
    return {"Authorization": f"Bearer {token}", "X-Workspace-Slug": "dev"}


def _upload(client, filename, content, content_type="application/octet-stream"):
    return client.post(
        "/api/files",
        headers=_admin_headers(),
        files={"file": (filename, io.BytesIO(content), content_type)},
    )


def test_upload_returns_metadata():
    client = TestClient(app)
    res = _upload(client, "hello.txt", b"hello world", "text/plain")
    assert res.status_code == 201, res.text
    data = res.json()["data"]
    assert data["filename"] == "hello.txt"
    assert data["mime_type"] == "text/plain"
    assert data["size"] == 11
    assert data["is_image"] is False
    assert isinstance(data["id"], str) and len(data["id"]) == 36

    # cleanup
    delete = client.delete(f"/api/files/{data['id']}", headers=_admin_headers())
    assert delete.status_code == 200


def test_upload_then_download_roundtrips_bytes():
    client = TestClient(app)
    payload = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32  # not a real png, but unique bytes
    res = _upload(client, "x.png", payload, "image/png")
    file_id = res.json()["data"]["id"]
    try:
        dl = client.get(f"/api/files/{file_id}", headers=_admin_headers())
        assert dl.status_code == 200
        assert dl.content == payload
        assert dl.headers["content-type"].startswith("image/png")
        assert "inline" in dl.headers.get("content-disposition", "")

        meta = client.get(f"/api/files/{file_id}/meta", headers=_admin_headers())
        assert meta.status_code == 200
        assert meta.json()["data"]["is_image"] is True
    finally:
        client.delete(f"/api/files/{file_id}", headers=_admin_headers())


def test_attachment_uses_attachment_disposition():
    client = TestClient(app)
    res = _upload(client, "doc.pdf", b"%PDF-1.4 fake", "application/pdf")
    file_id = res.json()["data"]["id"]
    try:
        dl = client.get(f"/api/files/{file_id}", headers=_admin_headers())
        assert "attachment" in dl.headers.get("content-disposition", "")
    finally:
        client.delete(f"/api/files/{file_id}", headers=_admin_headers())


def test_upload_requires_auth():
    client = TestClient(app)
    res = client.post(
        "/api/files",
        files={"file": ("x.txt", io.BytesIO(b"x"), "text/plain")},
    )
    assert res.status_code in (401, 403)


def test_download_unknown_file_404():
    client = TestClient(app)
    res = client.get(
        "/api/files/00000000-0000-0000-0000-000000000000",
        headers=_admin_headers(),
    )
    assert res.status_code == 404


def test_empty_upload_rejected():
    client = TestClient(app)
    res = _upload(client, "empty.txt", b"", "text/plain")
    assert res.status_code == 400


def test_non_owner_non_admin_cannot_delete():
    """Verify the delete-permission gate. We simulate a non-owner non-admin
    by uploading as admin (id=2) then trying to delete with the manager
    user (id=3) — manager is not admin and not the owner."""
    client = TestClient(app)
    res = _upload(client, "owned-by-admin.txt", b"x", "text/plain")
    file_id = res.json()["data"]["id"]
    try:
        manager_token = create_access_token(3)
        del_res = client.delete(
            f"/api/files/{file_id}",
            headers={
                "Authorization": f"Bearer {manager_token}",
                "X-Workspace-Slug": "dev-platform",
            },
        )
        assert del_res.status_code == 403
    finally:
        # Cleanup as the owner.
        client.delete(f"/api/files/{file_id}", headers=_admin_headers())
