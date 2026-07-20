"""엔티티 전체 CSV 내보내기 — GET /api/entities/export.csv.

관리 화면의 2만 표시 상한과 무관하게 축의 엔티티 전건을 스트리밍으로 내보낸다.
기본 컬럼 + 속성 + 별칭 + 사용수. 관리자 전용. q 로 검색 결과만도 가능.
일회용 축을 만들어 검증하고 끝나면 정리한다.
"""
from __future__ import annotations

import csv
import io
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
        json={"slug": "ex_" + sfx, "label": "내보내기축", "kind_class": "record"},
    ).json()["data"]["id"]


def _cleanup(c, tid):
    r = c.get(
        f"/api/entities?type_id={tid}&include_deprecated=true&limit=500", headers=_h()
    )
    if r.status_code == 200:
        for e in r.json()["data"]["items"]:
            c.delete(f"/api/entities/{e['id']}", headers=_h())
    c.delete(f"/api/entity-types/{tid}", headers=_h())


def _parse_csv(text: str):
    # BOM 제거 후 파싱.
    return list(csv.reader(io.StringIO(text.lstrip("﻿"))))


def test_export_csv_all_rows_with_property_and_alias():
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    tid = _mk_axis(c, sfx)
    try:
        # 속성 정의 1개(코드) + 엔티티 2건, 그 중 하나에 별칭.
        c.post(
            f"/api/entity-types/{tid}/properties",
            headers=_h(),
            json={"key": "grade", "label": "등급", "data_type": "text"},
        )
        e1 = c.post(
            "/api/entities", headers=_h(),
            json={"type_id": tid, "value": f"A-{sfx}", "code": "C001",
                  "properties": {"grade": "high"}},
        ).json()["data"]["id"]
        c.post(
            "/api/entities", headers=_h(),
            json={"type_id": tid, "value": f"B-{sfx}", "code": "C002",
                  "properties": {"grade": "low"}},
        )
        c.post(
            f"/api/entities/{e1}/aliases", headers=_h(),
            json={"alias": f"에이-{sfx}"},
        )

        r = c.get(f"/api/entities/export.csv?type_id={tid}", headers=_h())
        assert r.status_code == 200, r.text
        assert "text/csv" in r.headers["content-type"]
        assert "attachment" in r.headers["content-disposition"]
        assert r.text.startswith("﻿")  # Excel 용 BOM

        rows = _parse_csv(r.text)
        header, body = rows[0], rows[1:]
        # 기본 컬럼 + 속성 라벨(등급) + 별칭 + 사용수.
        assert header[:5] == ["id", "value", "code", "description", "status"]
        assert "등급" in header
        assert header[-2:] == ["aliases", "usage_count"]
        assert len(body) == 2, body

        by_value = {row[header.index("value")]: row for row in body}
        assert by_value[f"A-{sfx}"][header.index("등급")] == "high"
        assert by_value[f"A-{sfx}"][header.index("aliases")] == f"에이-{sfx}"
        assert by_value[f"B-{sfx}"][header.index("등급")] == "low"
        assert by_value[f"B-{sfx}"][header.index("aliases")] == ""
    finally:
        _cleanup(c, tid)


def test_export_csv_respects_q_filter():
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    tid = _mk_axis(c, sfx)
    try:
        c.post("/api/entities", headers=_h(),
               json={"type_id": tid, "value": f"apple-{sfx}"})
        c.post("/api/entities", headers=_h(),
               json={"type_id": tid, "value": f"banana-{sfx}"})

        r = c.get(f"/api/entities/export.csv?type_id={tid}&q=apple", headers=_h())
        assert r.status_code == 200
        rows = _parse_csv(r.text)
        body = rows[1:]
        assert len(body) == 1
        assert body[0][rows[0].index("value")] == f"apple-{sfx}"
    finally:
        _cleanup(c, tid)


def test_export_csv_admin_only():
    """비관리자는 403. (uid=3 은 일반 사용자 가정 — 실패 시 축만 정리.)"""
    c = TestClient(app)
    sfx = uuid.uuid4().hex[:8]
    tid = _mk_axis(c, sfx)
    try:
        r = c.get(
            f"/api/entities/export.csv?type_id={tid}",
            headers=_h(uid=3),
        )
        assert r.status_code == 403, r.text
    finally:
        _cleanup(c, tid)
