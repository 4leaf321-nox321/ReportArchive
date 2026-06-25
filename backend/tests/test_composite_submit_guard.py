"""종합보고 제출 가드 — 어느 조직 게시판에도 미게시(개인 공간 전용) 보고서는
제출 불가(먼저 최소 한 게시판에 게시해야). 게시 후에는 제출 가능.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token


def _h(slug="dx"):
    return {"Authorization": f"Bearer {create_access_token(1)}", "X-Workspace-Slug": slug}


def test_unmounted_report_cannot_be_submitted():
    client = TestClient(app)
    cid = client.post(
        "/api/composites",
        headers=_h(),
        json={"workspace_slug": "dx", "title": "제출가드", "kind": "theme"},
    ).json()["data"]["id"]
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    rid = client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "미게시 보고서",
            "tags": [],
        },
    ).json()["data"]["id"]

    # 미게시 → 400 + 게시 안내 메시지.
    r = client.post(
        f"/api/composites/{cid}/requests", headers=_h(), json={"ref_report_id": rid}
    )
    assert r.status_code == 400, r.text
    assert "게시판에 게시" in (r.json().get("message") or "")

    # 게시 후 → 제출 성공.
    client.post(
        "/api/mounts", headers=_h(), json={"report_id": rid, "workspace_slugs": ["dx"]}
    )
    r2 = client.post(
        f"/api/composites/{cid}/requests", headers=_h(), json={"ref_report_id": rid}
    )
    assert r2.status_code == 201, r2.text

    client.delete(f"/api/composites/{cid}", headers=_h())
