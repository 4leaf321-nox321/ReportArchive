"""엔티티 관리 검색 — 속성(key/value)으로도 찾기.

GET /api/entities 에서 search_props(자유검색이 속성 값까지 커버) + prop=key:value
(특정 속성 지정 필터, 예: 년도=2025)를 검증한다. 일회용 축을 만들어 확인·정리한다.
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
    tid = c.post(
        "/api/entity-types",
        headers=_h(),
        json={"slug": "ps_" + sfx, "label": "속성검색축", "kind_class": "record"},
    ).json()["data"]["id"]
    for key, label in (("year", "년도"), ("owner", "담당")):
        c.post(
            f"/api/entity-types/{tid}/properties",
            headers=_h(),
            json={"key": key, "label": label, "data_type": "text"},
        )
    return tid


def _cleanup(c, tid):
    r = c.get(
        f"/api/entities?type_id={tid}&include_deprecated=true&limit=500", headers=_h()
    )
    if r.status_code == 200:
        for e in r.json()["data"]["items"]:
            c.delete(f"/api/entities/{e['id']}", headers=_h())
    c.delete(f"/api/entity-types/{tid}", headers=_h())


def _values(c, url):
    r = c.get(url, headers=_h())
    assert r.status_code == 200, r.text
    return sorted(x["value"] for x in r.json()["data"]["items"])


def test_prop_key_value_filter_and_search_props():
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    tid = _mk_axis(c, sfx)
    try:
        # 3건 — year 2024/2025/2025, owner 값 다양.
        for val, year, owner in (
            (f"P1-{sfx}", "2024", "kim"),
            (f"P2-{sfx}", "2025", "lee"),
            (f"P3-{sfx}", "2025", "park"),
        ):
            c.post(
                "/api/entities", headers=_h(),
                json={"type_id": tid, "value": val,
                      "properties": {"year": year, "owner": owner}},
            )

        base = f"/api/entities?type_id={tid}&include_deprecated=true&with_usage=true"

        # 1) prop=year:2025 → 2건만.
        assert _values(c, f"{base}&prop=year:2025") == [f"P2-{sfx}", f"P3-{sfx}"]

        # 2) 두 속성 AND — year=2025 & owner=park → 1건.
        assert _values(c, f"{base}&prop=year:2025&prop=owner:park") == [f"P3-{sfx}"]

        # 3) search_props 없이 q=park → 값·코드·설명만 보므로 0건(속성 무시).
        assert _values(c, f"{base}&q=park") == []

        # 4) search_props=true 로 q=park → 속성 값까지 훑어 1건.
        assert _values(c, f"{base}&q=park&search_props=true") == [f"P3-{sfx}"]

        # 5) 없는 값 → 빈 목록.
        assert _values(c, f"{base}&prop=year:1999") == []
    finally:
        _cleanup(c, tid)


def test_export_csv_with_prop_filter():
    """전체 CSV 도 같은 prop 필터를 받아 그 결과만 내보낸다."""
    import csv
    import io

    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    tid = _mk_axis(c, sfx)
    try:
        for val, year in ((f"A-{sfx}", "2024"), (f"B-{sfx}", "2025")):
            c.post("/api/entities", headers=_h(),
                   json={"type_id": tid, "value": val, "properties": {"year": year}})

        r = c.get(f"/api/entities/export.csv?type_id={tid}&prop=year:2025", headers=_h())
        assert r.status_code == 200, r.text
        rows = list(csv.reader(io.StringIO(r.text.lstrip("﻿"))))
        body = rows[1:]
        assert len(body) == 1
        assert body[0][rows[0].index("value")] == f"B-{sfx}"
    finally:
        _cleanup(c, tid)
