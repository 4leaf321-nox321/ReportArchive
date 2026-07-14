"""(B) 검색 필터 통합 — /api/reports/search 의 날짜범위·작성자 필터.

순수 조립 로직은 test_report_filters.py 가, 여기선 엔드포인트가 필터 쿼리 파라미터를
받아 가시 스코프에 교집합으로 얹는 동작을 검증한다(report_date/작성자). report_type
등 나머지 축은 같은 report_column_conditions 를 공유하므로 대표로 날짜·작성자만.

실행 전제: 공유 Postgres 가 head 까지 마이그레이션돼 있어야 한다.
    cd backend && python -m pytest tests/test_report_filter_search.py -v
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.reports.models import Report


def _h(uid=1, slug="dx"):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": slug,
    }


def _create(client, title):
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    return client.post(
        "/api/reports",
        headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": title,
            "tags": [],
        },
    ).json()["data"]


def _set_report_date(rid, d: date):
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        r.report_date = d
        db.commit()
    finally:
        db.close()


def _purge(rid):
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        if r:
            db.delete(r)
            db.commit()
    finally:
        db.close()


def _search(client, **params):
    r = client.get("/api/reports/search", params=params, headers=_h())
    assert r.status_code == 200, r.text
    return {hit["report"]["id"] for hit in r.json()["data"]["results"]}


def test_date_range_filters_by_report_date():
    client = TestClient(app)
    tag = uuid.uuid4().hex[:8]
    old = _create(client, f"날짜{tag} 옛날 보고서")["id"]
    recent = _create(client, f"날짜{tag} 최근 보고서")["id"]
    try:
        _set_report_date(old, date(2020, 1, 15))
        _set_report_date(recent, date(2026, 7, 10))
        # 2026 상반기~오늘 범위 → 최근 것만.
        ids = _search(client, q=f"날짜{tag}", date_from="2026-01-01", date_to="2026-12-31")
        assert recent in ids
        assert old not in ids
        # 2020 범위 → 옛날 것만.
        ids = _search(client, q=f"날짜{tag}", date_from="2020-01-01", date_to="2020-12-31")
        assert old in ids
        assert recent not in ids
    finally:
        _purge(old)
        _purge(recent)


def test_last_days_relative_window():
    client = TestClient(app)
    tag = uuid.uuid4().hex[:8]
    old = _create(client, f"상대{tag} 30일전")["id"]
    fresh = _create(client, f"상대{tag} 오늘")["id"]
    try:
        _set_report_date(old, date.today() - timedelta(days=30))
        _set_report_date(fresh, date.today())
        ids = _search(client, q=f"상대{tag}", last_days=7)
        assert fresh in ids
        assert old not in ids
    finally:
        _purge(old)
        _purge(fresh)


def test_author_filter():
    client = TestClient(app)
    tag = uuid.uuid4().hex[:8]
    rid = _create(client, f"작성자{tag} 보고서")["id"]  # owner = uid 1
    try:
        # 작성자 = uid 1 → 포함.
        assert rid in _search(client, q=f"작성자{tag}", author_ids=1)
        # 존재하지 않는 작성자 → 제외.
        assert rid not in _search(client, q=f"작성자{tag}", author_ids=9_999_999)
    finally:
        _purge(rid)


def test_sort_by_report_date():
    client = TestClient(app)
    tag = uuid.uuid4().hex[:8]
    older = _create(client, f"정렬{tag} 예전")["id"]
    newer = _create(client, f"정렬{tag} 최근")["id"]
    try:
        _set_report_date(older, date(2021, 3, 1))
        _set_report_date(newer, date(2025, 9, 1))

        def _ordered(sort):
            r = client.get(
                "/api/reports/search",
                params={"q": f"정렬{tag}", "sort": sort},
                headers=_h(),
            )
            assert r.status_code == 200, r.text
            return [h["report"]["id"] for h in r.json()["data"]["results"]]

        recent = _ordered("recent")
        assert recent.index(newer) < recent.index(older)  # 최신이 위
        oldest = _ordered("oldest")
        assert oldest.index(older) < oldest.index(newer)  # 오래된 게 위
    finally:
        _purge(older)
        _purge(newer)


def test_bad_date_returns_400():
    client = TestClient(app)
    r = client.get(
        "/api/reports/search",
        params={"q": "x", "date_from": "not-a-date"},
        headers=_h(),
    )
    assert r.status_code == 400
