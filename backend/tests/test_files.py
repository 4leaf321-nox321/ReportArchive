"""Integration tests for the file upload/download/meta/delete endpoints.

Touches the live DB and writes to settings.upload_dir_path. Each test
cleans up the file it creates so the upload dir doesn't grow over time.
"""
import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token, create_upload_ticket


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


def test_upload_ticket_roundtrips_and_sets_ownership():
    """prepare_upload 흐름의 백엔드 절반: 티켓 발급 → 그 티켓으로 bearer 없이
    업로드 → 티켓의 user + **개인 워크스페이스**로 소유권이 박힌다(활성 보드가
    아니라 personal-{id} 로 태깅 — create_ai_draft 와 동일 정책)."""
    client = TestClient(app)
    mint = client.post("/api/files/upload-ticket", headers=_admin_headers())
    assert mint.status_code == 200, mint.text
    ticket = mint.json()["data"]["ticket"]
    assert ticket

    res = client.post(
        "/api/files/upload-with-ticket",
        files={"file": ("ticketed.png", io.BytesIO(b"\x89PNG\r\n\x1a\n" + b"\0" * 8), "image/png")},
        data={"ticket": ticket},
    )
    assert res.status_code == 201, res.text
    data = res.json()["data"]
    file_id = data["id"]
    try:
        assert data["owner_user_id"] == 2  # seeded admin from the ticket
        assert data["workspace_slug"] == "personal-2"  # 작성자 개인 공간
        assert data["is_image"] is True
    finally:
        client.delete(f"/api/files/{file_id}", headers=_admin_headers())


def test_upload_ticket_ignores_workspace_header():
    """티켓 발급은 PAT 만으로 동작한다 — X-Workspace-Slug 가 없어도(또는 무엇이든)
    개인 공간 기준으로 발급된다. 활성 부서 헤더에 의존하지 않음을 고정."""
    client = TestClient(app)
    token = create_access_token(2)
    # 워크스페이스 헤더 없이 발급
    mint = client.post("/api/files/upload-ticket", headers={"Authorization": f"Bearer {token}"})
    assert mint.status_code == 200, mint.text
    res = client.post(
        "/api/files/upload-with-ticket",
        files={"file": ("nows.png", io.BytesIO(b"\x89PNG\r\n\x1a\n" + b"\0" * 8), "image/png")},
        data={"ticket": mint.json()["data"]["ticket"]},
    )
    assert res.status_code == 201, res.text
    data = res.json()["data"]
    try:
        assert data["workspace_slug"] == "personal-2"
    finally:
        client.delete(f"/api/files/{data['id']}", headers=_admin_headers())


def test_legacy_ticket_with_board_workspace_still_uploads():
    """하위호환: mint 가 이제 personal-{id} 로 발급하지만, 예전에 발급돼
    **활성 보드 슬러그**(예: dev)가 박힌 티켓도 그 슬러그로 그대로 업로드돼야
    한다 — upload-with-ticket 은 클레임의 ws 를 신뢰할 뿐 형태를 가리지 않는다."""
    client = TestClient(app)
    ticket = create_upload_ticket(2, "dev")  # 옛 형식: 보드 슬러그 클레임
    res = client.post(
        "/api/files/upload-with-ticket",
        files={"file": ("legacy.png", io.BytesIO(b"\x89PNG\r\n\x1a\n" + b"\0" * 8), "image/png")},
        data={"ticket": ticket},
    )
    assert res.status_code == 201, res.text
    data = res.json()["data"]
    file_id = data["id"]
    try:
        assert data["owner_user_id"] == 2
        assert data["workspace_slug"] == "dev"  # 클레임의 보드 슬러그가 보존됨
    finally:
        client.delete(f"/api/files/{file_id}", headers=_admin_headers())


def test_upload_with_bad_ticket_rejected():
    client = TestClient(app)
    res = client.post(
        "/api/files/upload-with-ticket",
        files={"file": ("x.txt", io.BytesIO(b"x"), "text/plain")},
        data={"ticket": "not-a-real-ticket"},
    )
    assert res.status_code == 401


def _make_pptx(media):
    """Minimal .pptx-shaped zip: the extract endpoint only reads ppt/media/*,
    so a bare zip with those entries is enough to exercise it."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        for name, content in media:
            z.writestr(f"ppt/media/{name}", content)
    return buf.getvalue()


def test_extract_pptx_images():
    client = TestClient(app)
    pptx = _make_pptx(
        [
            ("image2.png", b"\x89PNG\r\n\x1a\nAAAA"),
            ("image10.png", b"\x89PNG\r\n\x1a\nBBBB"),
            ("image1.jpeg", b"\xff\xd8\xff\xe0CCCC"),
            ("media1.mp4", b"not-an-image"),  # non-image → skipped
        ]
    )
    up = _upload(
        client,
        "deck.pptx",
        pptx,
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    )
    assert up.status_code == 201, up.text
    source_id = up.json()["data"]["id"]
    extracted_ids = []
    try:
        res = client.post(
            f"/api/files/{source_id}/extract-images", headers=_admin_headers()
        )
        assert res.status_code == 200, res.text
        data = res.json()["data"]
        assert data["extracted"] == 3  # 3 images, mp4 skipped
        imgs = data["images"]
        extracted_ids = [i["id"] for i in imgs]
        # Natural sort: image1 < image2 < image10 (not lexical image1 < image10 < image2).
        assert [i["filename"] for i in imgs] == [
            "deck_img1.jpeg",
            "deck_img2.png",
            "deck_img3.png",
        ]
        assert all(i["owner_user_id"] == 2 and i["workspace_slug"] == "dev" for i in imgs)
    finally:
        for fid in extracted_ids:
            client.delete(f"/api/files/{fid}", headers=_admin_headers())
        client.delete(f"/api/files/{source_id}", headers=_admin_headers())


def test_extract_non_pptx_rejected():
    client = TestClient(app)
    up = _upload(client, "notes.txt", b"plain text", "text/plain")
    file_id = up.json()["data"]["id"]
    try:
        res = client.post(
            f"/api/files/{file_id}/extract-images", headers=_admin_headers()
        )
        assert res.status_code == 400
    finally:
        client.delete(f"/api/files/{file_id}", headers=_admin_headers())


@pytest.mark.skip(
    reason="X-Workspace-Slug 'dev-platform' 가 현재 dev DB 에 없어 권한검사 전에 404. "
    "이 가짜 부서를 dev DB 에 심으면 실제 앱 UI 오염. 전용 테스트 DB+결정적 시드"
    "(격리)가 생기면 해제."
)
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
