"""한 게시판의 여러 폴더에 게시(다중 폴더 배치, p89).

여러 부서에 게시하는 건 원래 됐지만, 한 부서 게시판 안에서는 폴더 하나만
고를 수 있었다(report_mounts.folder_id 단일 컬럼). 배치를 자식 테이블로
분리해 한 게시판에서 여러 폴더에 동시에 걸리게 한 것을 검증한다.

확인 대상:
  - PUT /api/mounts/{id}/{ws}/folders 로 폴더 집합 치환(추가·제외·미분류)
  - GET /api/mounts 의 folder_ids / folder_names
  - 게시판 목록의 folder_id 필터가 두 폴더 모두에서 이 보고서를 잡는지
  - 폴더 카운트(사이드바)가 두 폴더 모두에서 +1 되는지
  - 미분류(배치 0건) 복귀
"""
from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token

BOARD = "dev-hw"


def _h(slug="dx"):
    return {
        "Authorization": f"Bearer {create_access_token(1)}",
        "X-Workspace-Slug": slug,
    }


def _mount_row(client, rid):
    data = client.get(f"/api/mounts?report_id={rid}", headers=_h()).json()["data"]
    rows = data["items"] if isinstance(data, dict) else data
    return next((m for m in rows if m["workspace_slug"] == BOARD), None)


def _folder_ids_in_listing(client, folder_id):
    """BOARD 게시판을 folder_id 로 좁힌 목록의 보고서 id 집합."""
    r = client.get(
        f"/api/reports?folder_id={folder_id}", headers=_h(BOARD)
    ).json()["data"]
    return {x["id"] for x in r}


def _folder_count(client, folder_id):
    items = client.get(
        f"/api/folders?workspace_slug={BOARD}", headers=_h(BOARD)
    ).json()["data"]["items"]
    f = next((x for x in items if x["id"] == folder_id), None)
    return f["report_count"] if f else None


def test_mount_can_sit_in_several_folders_of_one_board():
    client = TestClient(app)
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    rid = client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "다중 폴더 게시 테스트",
            "tags": [],
        },
    ).json()["data"]["id"]
    created_folders = []
    try:
        # 이 게시판에 폴더 두 개 준비.
        for name in ("다중폴더A", "다중폴더B"):
            r = client.post(
                f"/api/folders?workspace_slug={BOARD}", headers=_h(BOARD), json={"name": name}
            )
            assert r.status_code in (200, 201), r.text
            created_folders.append(r.json()["data"]["id"])
        fa, fb = created_folders
        base_a, base_b = _folder_count(client, fa), _folder_count(client, fb)

        r = client.post(
            "/api/mounts",
            headers=_h(),
            json={"report_id": rid, "workspace_slugs": [BOARD]},
        )
        assert r.status_code == 200, r.text
        assert _mount_row(client, rid)["folder_ids"] == []  # 미분류로 시작

        # 두 폴더에 동시에 배치.
        r = client.put(
            f"/api/mounts/{rid}/{BOARD}/folders",
            headers=_h(),
            json={"folder_ids": [fa, fb]},
        )
        assert r.status_code == 200, r.text
        assert sorted(r.json()["data"]["folder_ids"]) == sorted([fa, fb])

        row = _mount_row(client, rid)
        assert sorted(row["folder_ids"]) == sorted([fa, fb])
        assert set(row["folder_names"]) == {"다중폴더A", "다중폴더B"}
        # 단일 폴더만 다루는 옛 호출부용 대표값도 채워진다.
        assert row["folder_id"] in (fa, fb)

        # 두 폴더 목록 모두에서 잡히고, 카운트도 각각 늘어난다.
        assert rid in _folder_ids_in_listing(client, fa)
        assert rid in _folder_ids_in_listing(client, fb)
        assert _folder_count(client, fa) == base_a + 1
        assert _folder_count(client, fb) == base_b + 1

        # 한 폴더에서만 제외 — 나머지 배치는 유지.
        client.put(
            f"/api/mounts/{rid}/{BOARD}/folders",
            headers=_h(),
            json={"folder_ids": [fb]},
        )
        row = _mount_row(client, rid)
        assert row["folder_ids"] == [fb]
        assert rid not in _folder_ids_in_listing(client, fa)
        assert rid in _folder_ids_in_listing(client, fb)

        # 빈 리스트 = 미분류 복귀.
        client.put(
            f"/api/mounts/{rid}/{BOARD}/folders", headers=_h(), json={"folder_ids": []}
        )
        row = _mount_row(client, rid)
        assert row["folder_ids"] == [] and row["folder_id"] is None
        assert rid in _folder_ids_in_listing(client, "uncategorized")
    finally:
        client.delete(f"/api/reports/{rid}", headers=_h())
        for fid in created_folders:
            client.delete(f"/api/folders/{fid}?workspace_slug={BOARD}", headers=_h(BOARD))


def test_mount_create_accepts_folder_ids_and_single_put_replaces():
    """게시(POST)할 때부터 여러 폴더를 지정할 수 있고, 단일 폴더 PUT 은
    '이동' 이라 기존 배치를 전부 대체한다."""
    client = TestClient(app)
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    rid = client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": "게시 시 다중 폴더 지정",
            "tags": [],
        },
    ).json()["data"]["id"]
    created_folders = []
    try:
        for name in ("게시시폴더A", "게시시폴더B"):
            created_folders.append(
                client.post(
                    f"/api/folders?workspace_slug={BOARD}", headers=_h(BOARD), json={"name": name}
                ).json()["data"]["id"]
            )
        fa, fb = created_folders

        r = client.post(
            "/api/mounts",
            headers=_h(),
            json={
                "report_id": rid,
                "workspace_slugs": [BOARD],
                "folder_ids": [fa, fb],
            },
        )
        assert r.status_code == 200, r.text
        assert sorted(_mount_row(client, rid)["folder_ids"]) == sorted([fa, fb])

        # 단일 폴더 PUT = 이동(대체).
        client.put(
            f"/api/mounts/{rid}/{BOARD}/folder", headers=_h(), json={"folder_id": fa}
        )
        assert _mount_row(client, rid)["folder_ids"] == [fa]
    finally:
        client.delete(f"/api/reports/{rid}", headers=_h())
        for fid in created_folders:
            client.delete(f"/api/folders/{fid}?workspace_slug={BOARD}", headers=_h(BOARD))
