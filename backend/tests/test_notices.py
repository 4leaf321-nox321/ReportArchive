"""공지 게시판 스모크 테스트 — 관리자만 작성/수정/삭제, 전원 열람.

id 2 = 시스템 관리자(작성 가능), id 3 = 비관리자(열람만). conftest 가 두
사용자를 보장한다.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token


def _headers(uid: int) -> dict:
    return {"Authorization": f"Bearer {create_access_token(uid)}"}


ADMIN = 2      # is_system_admin=True
NON_ADMIN = 3  # 비관리자


@pytest.fixture
def client():
    return TestClient(app)


def test_non_admin_cannot_create(client):
    r = client.post(
        "/api/notices",
        json={"title": "비관리자 공지", "body": "x"},
        headers=_headers(NON_ADMIN),
    )
    assert r.status_code == 403, r.text


def test_admin_crud_and_everyone_can_read(client):
    # 관리자 작성
    r = client.post(
        "/api/notices",
        json={"title": "테스트 공지", "body": "본문", "pinned": True},
        headers=_headers(ADMIN),
    )
    assert r.status_code == 201, r.text
    post = r.json()["data"]
    pid = post["id"]
    assert post["pinned"] is True
    assert post["author"]["id"] == ADMIN

    try:
        # 비관리자도 목록/상세 열람 가능
        r = client.get("/api/notices", headers=_headers(NON_ADMIN))
        assert r.status_code == 200, r.text
        ids = [it["id"] for it in r.json()["data"]["items"]]
        assert pid in ids

        r = client.get(f"/api/notices/{pid}", headers=_headers(NON_ADMIN))
        assert r.status_code == 200, r.text

        # 비관리자는 수정/삭제 불가
        r = client.patch(
            f"/api/notices/{pid}",
            json={"title": "해킹"},
            headers=_headers(NON_ADMIN),
        )
        assert r.status_code == 403, r.text
        r = client.delete(f"/api/notices/{pid}", headers=_headers(NON_ADMIN))
        assert r.status_code == 403, r.text

        # 관리자는 수정(고정 해제) 가능
        r = client.patch(
            f"/api/notices/{pid}",
            json={"pinned": False, "title": "수정된 공지"},
            headers=_headers(ADMIN),
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["pinned"] is False
        assert r.json()["data"]["title"] == "수정된 공지"
    finally:
        # 관리자 삭제(정리)
        r = client.delete(f"/api/notices/{pid}", headers=_headers(ADMIN))
        assert r.status_code == 200, r.text


def test_popup_shows_latest_once_and_only_latest(client):
    """팝업 정책: 가장 최근 공지 1건만, 확인하면 다시 안 뜬다. 여러 개 밀려도
    '마지막(최신)'만 대상."""
    # 먼저 이 사용자의 seen mark 를 현재 최신으로 올려 깨끗한 출발선 확보.
    r = client.get("/api/notices/popup", headers=_headers(NON_ADMIN))
    assert r.status_code == 200, r.text
    cur = r.json()["data"]
    if cur is not None:
        client.post(
            "/api/notices/popup/seen",
            json={"notice_id": cur["id"]},
            headers=_headers(NON_ADMIN),
        )
    # 이제 팝업 없음.
    r = client.get("/api/notices/popup", headers=_headers(NON_ADMIN))
    assert r.json()["data"] is None, r.text

    # 관리자가 공지 2건 연속 작성.
    created = []
    for t in ("공지 A", "공지 B"):
        r = client.post(
            "/api/notices",
            json={"title": t, "body": t},
            headers=_headers(ADMIN),
        )
        assert r.status_code == 201, r.text
        created.append(r.json()["data"]["id"])
    a_id, b_id = created
    assert b_id > a_id

    try:
        # 팝업은 '마지막(B)' 1건만.
        r = client.get("/api/notices/popup", headers=_headers(NON_ADMIN))
        pop = r.json()["data"]
        assert pop is not None and pop["id"] == b_id, r.text

        # 확인 처리 → 더 이상 안 뜸(A 도 뜨지 않음).
        r = client.post(
            "/api/notices/popup/seen",
            json={"notice_id": b_id},
            headers=_headers(NON_ADMIN),
        )
        assert r.status_code == 200, r.text
        r = client.get("/api/notices/popup", headers=_headers(NON_ADMIN))
        assert r.json()["data"] is None, r.text
    finally:
        for nid in created:
            client.delete(f"/api/notices/{nid}", headers=_headers(ADMIN))
