"""안건 제출 요청의 작성 경로(via) 표식 — 사람이 낸 요청과 AI(MCP)가 낸 요청.

이 큐는 **사람이 승인**한다. 그런데 MCP 는 사용자의 토큰으로 동작하므로,
표식이 없으면 승인 화면에서 둘이 똑같아 보인다. 승인자가 판단할 근거가
하나 빠지는 셈이라 서버가 `X-Client: mcp` 를 보고 채운다(p92).
댓글 p90 · 게시 p91 과 같은 규약.

Run: cd backend && ./venv/bin/python -m pytest tests/test_composite_request_via.py -v
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token

H = {"Authorization": f"Bearer {create_access_token(1)}", "X-Workspace-Slug": "dx"}
H_MCP = {**H, "X-Client": "mcp"}


def _make_mounted_report(client: TestClient) -> int:
    tpl = client.get("/api/templates", headers=H).json()["data"][0]
    rid = client.post(
        "/api/reports",
        headers=H,
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "via 표식 테스트",
            "tags": [],
        },
    ).json()["data"]["id"]
    client.post(
        "/api/mounts", headers=H, json={"report_id": rid, "workspace_slugs": ["dx"]}
    )
    return rid


def test_request_via_marks_web_and_mcp():
    client = TestClient(app)
    cid = client.post(
        "/api/composites",
        headers=H,
        json={"workspace_slug": "dx", "title": "via 큐", "kind": "theme"},
    ).json()["data"]["id"]
    try:
        # 사람이 화면에서 낸 요청 → 'web'.
        rid_web = _make_mounted_report(client)
        r = client.post(
            f"/api/composites/{cid}/requests", headers=H, json={"ref_report_id": rid_web}
        )
        assert r.status_code == 201, r.text
        assert r.json()["data"]["via"] == "web"

        # AI 가 그 사람 권한으로 낸 요청 → 'mcp'.
        rid_mcp = _make_mounted_report(client)
        r2 = client.post(
            f"/api/composites/{cid}/requests",
            headers=H_MCP,
            json={"ref_report_id": rid_mcp},
        )
        assert r2.status_code == 201, r2.text
        assert r2.json()["data"]["via"] == "mcp"

        # 대기 목록(승인 화면이 읽는 곳)에도 그대로 실려야 한다 — 여기서
        # 안 보이면 표식을 남긴 의미가 없다.
        pending = client.get(
            f"/api/composites/{cid}/requests", headers=H
        ).json()["data"]
        by_report = {p["ref_report_id"]: p["via"] for p in pending}
        assert by_report[rid_web] == "web"
        assert by_report[rid_mcp] == "mcp"
    finally:
        client.delete(f"/api/composites/{cid}", headers=H)
