"""게시 메모(mount note) — 생성 시 저장, PUT 으로 수정, 보고서 목록 칩에 노출.

옵션 1(목록 칩 note) + 옵션 2(게시 현황 패널 수정)를 뒷받침하는 API 검증.
"""
from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token

BOARD = "dev-hw"


def _h():
    return {
        "Authorization": f"Bearer {create_access_token(1)}",
        "X-Workspace-Slug": "dx",
    }


def _mount_note(rid):
    """현재 게시 목록에서 BOARD 게시의 note."""
    data = TestClient(app).get(f"/api/mounts?report_id={rid}", headers=_h()).json()["data"]
    rows = data["items"] if isinstance(data, dict) else data
    row = next((m for m in rows if m["workspace_slug"] == BOARD), None)
    return row["note"] if row else None


def test_mount_note_create_update_and_list_chip():
    client = TestClient(app)
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    rid = client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "게시 메모 테스트",
            "tags": [],
        },
    ).json()["data"]["id"]
    try:
        # 게시 시 메모 저장.
        r = client.post(
            "/api/mounts",
            headers=_h(),
            json={"report_id": rid, "workspace_slugs": [BOARD], "note": "최초 메모"},
        )
        assert r.status_code == 200, r.text
        assert _mount_note(rid) == "최초 메모"

        # PUT 으로 메모 수정.
        r = client.put(
            f"/api/mounts/{rid}/{BOARD}/note",
            headers=_h(),
            json={"note": "  수정된 메모  "},
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["note"] == "수정된 메모"  # trim 됨
        assert _mount_note(rid) == "수정된 메모"

        # 보고서 목록 칩(mount_workspaces)에도 note 노출(옵션 1). 작성자
        # 개인공간 컨텍스트에서 본인 보고서 + 게시 칩이 보인다.
        hp = {
            "Authorization": f"Bearer {create_access_token(1)}",
            "X-Workspace-Slug": "personal-1",
        }
        reports = client.get("/api/reports", headers=hp).json()["data"]
        rep = next((x for x in reports if x["id"] == rid), None)
        assert rep is not None
        mw = next(
            (m for m in (rep.get("mount_workspaces") or []) if m["slug"] == BOARD),
            None,
        )
        assert mw is not None and mw.get("note") == "수정된 메모", rep.get(
            "mount_workspaces"
        )

        # 빈 문자열로 메모 삭제.
        client.put(f"/api/mounts/{rid}/{BOARD}/note", headers=_h(), json={"note": ""})
        assert _mount_note(rid) == ""
    finally:
        client.delete(f"/api/reports/{rid}", headers=_h())
