"""End-to-end smoke for file upload + report integration.

  1. Upload a fake PNG → get file_id
  2. Create a temporary widget-v1 template with image+attachment blocks
  3. Create a report referencing the uploaded file_id
  4. Read it back, verify content shape
  5. Cleanup (delete report, file, template)

Run with backend up on :3000.
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import requests

API = "http://localhost:3000/api"


def login() -> str:
    r = requests.post(
        f"{API}/auth/login",
        json={"email": "admin@example.com", "password": "admin1234"},
        timeout=5,
    )
    r.raise_for_status()
    return r.json()["data"]["access_token"]


def headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "X-Workspace-Slug": "dev"}


def main() -> int:
    token = login()
    print("[OK] login")

    # 1. Upload a fake PNG.
    fake_png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    r = requests.post(
        f"{API}/files",
        headers=headers(token),
        files={"file": ("smoke.png", io.BytesIO(fake_png), "image/png")},
        timeout=5,
    )
    if r.status_code != 201:
        print(f"[ERR] upload failed: {r.status_code} {r.text}")
        return 1
    meta = r.json()["data"]
    file_id = meta["id"]
    assert meta["is_image"] is True
    assert meta["mime_type"] == "image/png"
    print(f"[OK] upload: file_id={file_id}, size={meta['size']}")

    # 2. Create temporary template with image + attachment blocks.
    template_payload = {
        "template_id": "smoke-files-test",
        "name": "Files smoke",
        "description": "temp",
        "category": "misc",
        "schema": {
            "version": "widget-v1",
            "blocks": [
                {
                    "id": "evidence",
                    "type": "image",
                    "props": {"label": "이미지", "max_count": 3},
                },
                {
                    "id": "docs",
                    "type": "attachment",
                    "props": {"label": "문서", "max_count": 5},
                },
            ],
        },
        "owner_workspace_slug": None,
    }
    r = requests.post(f"{API}/templates", json=template_payload, headers=headers(token), timeout=5)
    if r.status_code not in (200, 201):
        print(f"[ERR] template create: {r.status_code} {r.text}")
        return 1
    template = r.json()["data"]
    print(f"[OK] template created: {template['template_id']} v{template['version']}")

    # 3. Create a report referencing the uploaded file in BOTH widgets.
    upload_meta = meta
    report_payload = {
        "template_id": "smoke-files-test",
        "template_version": 1,
        "title": "smoke files",
        "content": {
            "evidence": {"files": [{"file_id": file_id, "caption": "테스트", "alt": "smoke"}]},
            "docs": {
                "files": [
                    {"file_id": file_id, "filename": upload_meta["filename"], "size": upload_meta["size"]}
                ]
            },
        },
    }
    r = requests.post(f"{API}/reports", json=report_payload, headers=headers(token), timeout=5)
    if r.status_code not in (200, 201):
        print(f"[ERR] report create: {r.status_code} {r.text}")
        return 1
    report_id = r.json()["data"]["id"]
    print(f"[OK] report created: id={report_id}")

    # 4. Read it back and verify shape.
    r = requests.get(f"{API}/reports/{report_id}", headers=headers(token), timeout=5)
    rb = r.json()["data"]
    assert rb["content"]["evidence"]["files"][0]["file_id"] == file_id
    assert rb["content"]["docs"]["files"][0]["filename"] == upload_meta["filename"]
    print("[OK] roundtrip verified")

    # 5. Verify that bytes still download cleanly.
    r = requests.get(f"{API}/files/{file_id}", headers=headers(token), timeout=5)
    assert r.status_code == 200 and r.content == fake_png
    print("[OK] download bytes match")

    # 6. Cleanup — order matters (RESTRICT FKs).
    requests.delete(f"{API}/reports/{report_id}", headers=headers(token), timeout=5)
    requests.delete(f"{API}/files/{file_id}", headers=headers(token), timeout=5)
    # Template has no delete endpoint — leave it; harmless for dev.
    print("[OK] cleanup (template smoke-files-test left in DB; manual remove if needed)")

    print("\n[DONE] file-upload smoke passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
