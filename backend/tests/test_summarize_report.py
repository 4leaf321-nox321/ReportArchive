"""보고서 자동 요약/태깅 (B, §B) — 핸들러 게이트/skip/소프트삭제 + 읽기 API.

작성자 엔티틀먼트 게이트(admin bypass vs 미권한), content_hash skip, 소프트삭제
정리, GET /reports/{id}/ai-summary. mock LLM 이라 내용 품질은 검증 안 함(행 생성·게이트만).
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.ai.models import ReportAiSummary
from app.database import SessionLocal
from app.jobs.handlers.summarize_report import summarize_report
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.reports.models import Report

ADMIN = 2  # bypass → auto_summary entitled
USER = 3   # 미권한


def _h(uid):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": f"personal-{uid}",
    }


def _create_report(c, uid, title):
    tpl = c.get("/api/templates", headers=_h(uid)).json()["data"][0]
    return c.post(
        "/api/reports",
        headers=_h(uid),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": title,
            "tags": [],
        },
    ).json()["data"]["id"]


def _drop(rid):
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        if r:
            db.delete(r)  # report_ai_summaries CASCADE
            db.commit()
    finally:
        db.close()


def test_summarize_creates_preserves_and_force_regenerates():
    c = TestClient(app)
    rid = _create_report(c, ADMIN, "AUTOSUM " + uuid.uuid4().hex[:6])
    db = SessionLocal()
    try:
        out = summarize_report(db, {"report_id": rid})
        assert out.get("skipped") is None, out  # 없음 → 생성
        row = db.get(ReportAiSummary, rid)
        assert row is not None and row.summary != ""

        # 자동 재호출 — 기존 보존(덮어쓰지 않음).
        out2 = summarize_report(db, {"report_id": rid})
        assert out2.get("skipped") == "exists"

        # force(수동 '다시 생성'·일괄) → 재생성.
        out3 = summarize_report(db, {"report_id": rid, "force": True})
        assert out3.get("skipped") is None, out3

        # 읽기 API.
        r = c.get(f"/api/reports/{rid}/ai-summary", headers=_h(ADMIN))
        assert r.status_code == 200, r.text
        assert r.json()["data"]["summary"] != ""
    finally:
        db.close()
        _drop(rid)


def test_summarize_editor_entitled_passes():
    """소유자가 미권한이어도 최근 편집자(updated_by)가 권한자면 자동 요약 생성."""
    c = TestClient(app)
    rid = _create_report(c, ADMIN, "EDITOR " + uuid.uuid4().hex[:6])
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        r.owner_user_id = USER          # 소유자=미권한
        r.updated_by_user_id = ADMIN    # 최근 편집자=권한자(bypass)
        db.commit()
        out = summarize_report(db, {"report_id": rid})
        assert out.get("skipped") is None, out  # 편집자 기준 통과 → 생성
    finally:
        db.close()
        _drop(rid)


def test_summarize_not_entitled_skips():
    c = TestClient(app)
    # admin 으로 생성 후 소유자를 미권한 유저로 바꿔 "작성자 게이트"를 검증.
    rid = _create_report(c, ADMIN, "NOENT " + uuid.uuid4().hex[:6])
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        # 소유자·최근 편집자 둘 다 미권한이어야 게이트가 막힌다(owner OR editor).
        r.owner_user_id = USER
        r.updated_by_user_id = USER
        db.commit()
        out = summarize_report(db, {"report_id": rid})
        assert out.get("skipped") == "not_entitled", out
        assert db.get(ReportAiSummary, rid) is None
    finally:
        db.close()
        _drop(rid)


def test_summarize_soft_delete_removes():
    c = TestClient(app)
    rid = _create_report(c, ADMIN, "SOFTDEL " + uuid.uuid4().hex[:6])
    db = SessionLocal()
    try:
        summarize_report(db, {"report_id": rid})
        assert db.get(ReportAiSummary, rid) is not None

        from datetime import datetime

        r = db.get(Report, rid)
        r.deleted_at = datetime.utcnow()
        db.commit()
        out = summarize_report(db, {"report_id": rid})
        assert out.get("skipped") == "deleted"
        db.expire_all()
        assert db.get(ReportAiSummary, rid) is None
    finally:
        db.close()
        _drop(rid)
