"""저장된 검색(스마트 폴더) CRUD — /api/saved-searches.

소유권 격리(남의 것 못 봄/못 지움)·필터 왕복(저장→조회 동일)·구독 토글 시 워터마크
세팅을 검증. 검색 실행 자체는 기존 /reports/search 가 담당하므로 여기선 저장소만.
    cd backend && python -m pytest tests/test_saved_searches.py -v
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.saved_searches.models import SavedSearch
from app.modules.users.models import User


def _h(uid=1):
    return {"Authorization": f"Bearer {create_access_token(uid)}"}


def _ensure_user(email):
    db = SessionLocal()
    try:
        u = db.query(User).filter_by(email=email).one_or_none()
        if u is None:
            u = User(email=email, name=email, password_hash="!unused-tests-only")
            db.add(u)
            db.commit()
        return u.id
    finally:
        db.close()


def _purge(sid):
    db = SessionLocal()
    try:
        r = db.get(SavedSearch, sid)
        if r:
            db.delete(r)
            db.commit()
    finally:
        db.close()


def test_create_list_roundtrip_filters():
    client = TestClient(app)
    name = f"저장{uuid.uuid4().hex[:6]}"
    body = {
        "name": name,
        "query": "낙하시험",
        "mode": "keyword",
        "filters": {
            "lastDays": 7,
            "dateField": "report_date",
            "reportTypeIds": [1, 2],
            "phases": ["finalized"],
            "junk_key": "dropped",  # extra="ignore" 로 버려져야
        },
    }
    r = client.post("/api/saved-searches", headers=_h(), json=body)
    assert r.status_code == 201, r.text
    sid = r.json()["data"]["id"]
    try:
        rows = client.get("/api/saved-searches", headers=_h()).json()["data"]
        mine = next(x for x in rows if x["id"] == sid)
        assert mine["name"] == name
        assert mine["query"] == "낙하시험"
        assert mine["filters"]["lastDays"] == 7
        assert mine["filters"]["phases"] == ["finalized"]
        assert "junk_key" not in mine["filters"]  # 알 수 없는 키 제거
    finally:
        _purge(sid)


def test_ownership_isolation():
    client = TestClient(app)
    other = _ensure_user("saved-other@test.local")
    r = client.post(
        "/api/saved-searches", headers=_h(),
        json={"name": f"내것{uuid.uuid4().hex[:6]}", "filters": {}},
    )
    sid = r.json()["data"]["id"]
    try:
        # 남(other)은 목록에서 못 본다.
        rows = client.get("/api/saved-searches", headers=_h(other)).json()["data"]
        assert all(x["id"] != sid for x in rows)
        # 남은 못 지운다(404).
        assert client.delete(f"/api/saved-searches/{sid}", headers=_h(other)).status_code == 404
        # 남은 못 고친다(404).
        assert client.patch(
            f"/api/saved-searches/{sid}", headers=_h(other), json={"name": "x"}
        ).status_code == 404
    finally:
        _purge(sid)


def test_subscribe_sets_watermark():
    client = TestClient(app)
    r = client.post(
        "/api/saved-searches", headers=_h(),
        json={"name": f"구독{uuid.uuid4().hex[:6]}", "filters": {}},
    )
    sid = r.json()["data"]["id"]
    try:
        # 구독 켜기 → 워터마크가 세팅돼야(스케줄러가 이후 생성분만 새 것으로).
        client.patch(f"/api/saved-searches/{sid}", headers=_h(), json={"subscribed": True})
        db = SessionLocal()
        try:
            row = db.get(SavedSearch, sid)
            assert row.subscribed is True
            assert row.seen_watermark is not None
        finally:
            db.close()
    finally:
        _purge(sid)


def test_update_and_delete():
    client = TestClient(app)
    r = client.post(
        "/api/saved-searches", headers=_h(),
        json={"name": "old", "filters": {}},
    )
    sid = r.json()["data"]["id"]
    try:
        upd = client.patch(
            f"/api/saved-searches/{sid}", headers=_h(),
            json={"name": "new", "query": "q2"},
        )
        assert upd.status_code == 200
        assert upd.json()["data"]["name"] == "new"
        assert upd.json()["data"]["query"] == "q2"
        assert client.delete(f"/api/saved-searches/{sid}", headers=_h()).status_code == 200
        rows = client.get("/api/saved-searches", headers=_h()).json()["data"]
        assert all(x["id"] != sid for x in rows)
    finally:
        _purge(sid)
