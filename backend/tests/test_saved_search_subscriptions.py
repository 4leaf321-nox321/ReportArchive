"""저장검색 구독 감지 — run_subscription_checks 가 새 보고서를 잡아 알림 생성.

watermark 이후 created_at 인 매칭 보고서를 소유자 가시성 안에서 찾아 saved_search_hit
알림을 만들고 watermark 를 전진시키는지(재알림 안 함) 검증.
    cd backend && python -m pytest tests/test_saved_search_subscriptions.py -v
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.notifications.models import Notification, NotificationType
from app.modules.reports.models import Report
from app.modules.saved_searches.models import SavedSearch
from app.modules.saved_searches.subscriptions import run_subscription_checks


def _h(uid=1, slug="dx"):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": slug,
    }


def _create_report(client, title):
    tpl = client.get("/api/templates", headers=_h()).json()["data"][0]
    return client.post(
        "/api/reports", headers=_h(),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": title,
            "tags": [],
        },
    ).json()["data"]


def _cleanup(sid, rid):
    db = SessionLocal()
    try:
        for note in db.query(Notification).filter_by(
            ref_table="saved_searches", ref_id=sid
        ):
            db.delete(note)
        s = db.get(SavedSearch, sid)
        if s:
            db.delete(s)
        r = db.get(Report, rid)
        if r:
            db.delete(r)
        db.commit()
    finally:
        db.close()


def _notes_for(sid):
    db = SessionLocal()
    try:
        return list(
            db.query(Notification).filter_by(ref_table="saved_searches", ref_id=sid)
        )
    finally:
        db.close()


def test_subscription_detects_new_report_and_advances_watermark():
    client = TestClient(app)
    tag = uuid.uuid4().hex[:8]
    rep = _create_report(client, f"구독감지{tag} 새 보고서")
    rid = rep["id"]
    # 구독 저장검색 — 제목 검색어. watermark 를 과거로 세팅해 이 보고서를 '새 것'으로.
    saved = client.post(
        "/api/saved-searches", headers=_h(),
        json={"name": f"구독{tag}", "query": f"구독감지{tag}", "subscribed": True,
              "filters": {}},
    ).json()["data"]
    sid = saved["id"]
    db = SessionLocal()
    try:
        s = db.get(SavedSearch, sid)
        s.seen_watermark = datetime(2000, 1, 1)  # 과거 → 보고서가 새 것으로 잡힘
        db.commit()
    finally:
        db.close()

    try:
        # 1차 — 감지·알림.
        run_subscription_checks(SessionLocal())
        notes = _notes_for(sid)
        assert len(notes) == 1
        n = notes[0]
        assert n.recipient_user_id == 1
        assert n.type == NotificationType.saved_search_hit
        assert n.payload["new_count"] >= 1
        assert rid in n.payload["report_ids"]

        # watermark 가 전진했는지 → 2차 실행은 재알림 안 함(중복 방지).
        db = SessionLocal()
        try:
            s = db.get(SavedSearch, sid)
            assert s.seen_watermark.year >= 2026
            assert s.last_notified_at is not None
        finally:
            db.close()

        run_subscription_checks(SessionLocal())
        assert len(_notes_for(sid)) == 1  # 늘지 않음
    finally:
        _cleanup(sid, rid)


def test_unsubscribed_search_is_ignored():
    client = TestClient(app)
    tag = uuid.uuid4().hex[:8]
    rep = _create_report(client, f"미구독{tag} 보고서")
    rid = rep["id"]
    saved = client.post(
        "/api/saved-searches", headers=_h(),
        json={"name": f"미구독{tag}", "query": f"미구독{tag}", "subscribed": False,
              "filters": {}},
    ).json()["data"]
    sid = saved["id"]
    try:
        run_subscription_checks(SessionLocal())
        assert len(_notes_for(sid)) == 0  # 구독 안 했으면 알림 없음
    finally:
        _cleanup(sid, rid)
