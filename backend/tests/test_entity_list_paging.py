"""엔티티 목록 페이징 — GET /api/entities 의 offset.

limit 상한(500)이 곧 총량 상한이면 값이 500개를 넘는 축은 관리 화면이 조용히
잘려 보인다. offset 으로 끝까지 넘겨 전부 받을 수 있어야 한다. 일회용 축을
만들어 검증하고 끝나면 정리한다.
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.main import app
from app.modules.auth.services import create_access_token

ADMIN = 2  # is_system_admin


def _h(uid=ADMIN, slug="dx"):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": slug,
    }


def _mk_axis(c, sfx):
    return c.post(
        "/api/entity-types",
        headers=_h(),
        json={"slug": "pg_" + sfx, "label": "페이징축", "kind_class": "record"},
    ).json()["data"]["id"]


def _cleanup(c, tid):
    r = c.get(
        f"/api/entities?type_id={tid}&include_deprecated=true&limit=500", headers=_h()
    )
    if r.status_code == 200:
        for e in r.json()["data"]["items"]:
            c.delete(f"/api/entities/{e['id']}", headers=_h())
    c.delete(f"/api/entity-types/{tid}", headers=_h())


def _fetch_all(c, tid, page=5):
    """offset 을 끝까지 넘겨 모은다 — 프론트 listAllEntities 와 같은 방식."""
    ids, offset = [], 0
    while True:
        r = c.get(
            f"/api/entities?type_id={tid}&include_deprecated=true"
            f"&with_usage=true&limit={page}&offset={offset}",
            headers=_h(),
        )
        assert r.status_code == 200, r.text
        items = r.json()["data"]["items"]
        ids += [x["id"] for x in items]
        if len(items) < page:
            return ids
        offset += page


def test_offset_paging_collects_every_row_without_duplicates():
    c = TestClient(app)
    tid = _mk_axis(c, uuid.uuid4().hex[:8])
    try:
        n = 12
        for i in range(n):
            r = c.post(
                "/api/entities", headers=_h(), json={"type_id": tid, "value": f"v{i:02d}"}
            )
            assert r.status_code in (200, 201), r.text

        ids = _fetch_all(c, tid, page=5)  # 5 + 5 + 2
        assert len(ids) == n, f"{n}건 중 {len(ids)}건만 수집"
        assert len(set(ids)) == n, "페이지 경계에서 중복"
    finally:
        _cleanup(c, tid)


def test_offset_paging_matches_single_page_order():
    """페이지로 나눠 받아도 순서가 한 번에 받은 것과 같아야 한다(경계 흔들림 방지)."""
    c = TestClient(app)
    tid = _mk_axis(c, uuid.uuid4().hex[:8])
    try:
        for i in range(7):
            c.post("/api/entities", headers=_h(), json={"type_id": tid, "value": f"v{i}"})

        one = c.get(
            f"/api/entities?type_id={tid}&include_deprecated=true&limit=500",
            headers=_h(),
        ).json()["data"]["items"]
        assert [x["id"] for x in one] == _fetch_all(c, tid, page=2)
    finally:
        _cleanup(c, tid)


def test_offset_defaults_and_bounds():
    """offset 미지정은 예전과 동일(하위호환). 음수는 거부, limit 상한은 그대로."""
    c = TestClient(app)
    tid = _mk_axis(c, uuid.uuid4().hex[:8])
    try:
        for i in range(3):
            c.post("/api/entities", headers=_h(), json={"type_id": tid, "value": f"v{i}"})

        base = f"/api/entities?type_id={tid}&include_deprecated=true"
        assert len(c.get(base, headers=_h()).json()["data"]["items"]) == 3
        assert c.get(f"{base}&offset=-1", headers=_h()).status_code == 422
        assert c.get(f"{base}&limit=1000", headers=_h()).status_code == 422
        # 범위를 넘긴 offset 은 빈 목록(오류 아님) — 루프 종료 조건이 된다.
        assert c.get(f"{base}&offset=99", headers=_h()).json()["data"]["items"] == []
    finally:
        _cleanup(c, tid)
