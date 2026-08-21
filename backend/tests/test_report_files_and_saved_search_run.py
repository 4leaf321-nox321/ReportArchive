"""보고서 첨부 나열 · 저장검색 실행 — AI 가 읽을 수 있게 새로 연 두 창구.

- 첨부: `files` 테이블엔 report 연결이 없다(본문 content 안에 file_id 참조로만
  존재). 위젯 타입을 열거하면 **새 위젯이 생길 때 조용히 빠지므로** 키 이름으로
  재귀 수집한다 — 비교표처럼 셀 안에 든 것도 잡혀야 한다.
- 저장검색: 저장 필터는 내부 id·camelCase 라 AI 가 손으로 옮기면 어긋난다.
  서버가 **구독 알림과 같은 필터 경로**로 실행해 준다.

Run: cd backend && ./venv/bin/python -m pytest tests/test_report_files_and_saved_search_run.py -v
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.reports.models import Report
from app.modules.templates.models import Template

H = {
    "Authorization": f"Bearer {create_access_token(1)}",
    "X-Workspace-Slug": "personal-1",
}


def _make_template() -> str:
    db = SessionLocal()
    try:
        tid = f"files-{uuid.uuid4().hex[:8]}"
        db.add(Template(
            template_id=tid, version=1, name="files", description="", category="misc",
            schema={"version": "widget-v1", "blocks": [
                {"id": "h", "type": "heading", "props": {"label": "제목"}}]},
            owner_workspace_slugs=None, is_published=True, is_latest=True,
            created_by_user_id=None,
        ))
        db.commit()
        return tid
    finally:
        db.close()


def _cleanup(rids, tid):
    db = SessionLocal()
    try:
        for rid in rids:
            r = db.get(Report, rid)
            if r:
                db.delete(r)
        db.commit()
        t = db.get(Template, (tid, 1))
        if t:
            db.delete(t)
            db.commit()
    finally:
        db.close()


def test_report_files_finds_nested_and_missing_refs():
    """중첩된 file_id 도 찾고, 파일이 사라진 참조는 **숨기지 말고 표시**한다."""
    c = TestClient(app)
    tid = _make_template()
    rids = []
    try:
        rid = c.post("/api/reports/ai-draft", headers=H, json={
            "template_id": tid, "template_version": 1, "title": "첨부 나열",
            "blocks": {"h": {"text": "제목"}},
        }).json()["data"]["report_id"]
        rids.append(rid)

        # 본문에 file_id 참조를 직접 심는다(깊이 다른 두 곳 + 같은 파일 재사용).
        db = SessionLocal()
        try:
            r = db.get(Report, rid)
            pages = [dict(p) for p in (r.pages or [])]
            content = dict(pages[0].get("content") or {})
            content["img"] = {"files": [{"file_id": "ghost-1"}]}
            content["cmp"] = {"rows": [
                {"cells": [{"value": {"files": [{"file_id": "ghost-2"}]}}]},
                {"cells": [{"value": {"files": [{"file_id": "ghost-1"}]}}]},
            ]}
            pages[0] = {**pages[0], "content": content}
            r.pages = pages
            db.commit()
        finally:
            db.close()

        d = c.get(f"/api/reports/{rid}/files", headers=H).json()["data"]
        ids = {f["file_id"] for f in d["files"]}
        # 순서는 보장하지 않는다 — content 는 JSONB 라 키 순서가 저장 시 재정렬된다.
        assert ids == {"ghost-1", "ghost-2"}, ids
        assert d["count"] == 2

        by_id = {f["file_id"]: f for f in d["files"]}
        # 같은 파일이 두 곳(블록 img · 비교표 셀 안)에서 쓰였다 — 중첩 수집 확인.
        assert len(by_id["ghost-1"]["used_at"]) == 2, by_id["ghost-1"]
        assert {u["block_id"] for u in by_id["ghost-1"]["used_at"]} == {"img", "cmp"}
        # 존재하지 않는 파일은 조용히 빼지 않는다.
        assert all(f["missing"] for f in d["files"])
    finally:
        _cleanup(rids, tid)


def test_report_files_requires_read_permission():
    c = TestClient(app)
    from app.modules.users.models import Role
    from tests.test_report_search import _ensure_member  # 재사용

    uid = _ensure_member("files-other@test.local", "dev-hw", Role.user)
    other = {"Authorization": f"Bearer {create_access_token(uid)}",
             "X-Workspace-Slug": "dev-hw"}
    tid = _make_template()
    rids = []
    try:
        rid = c.post("/api/reports/ai-draft", headers=H, json={
            "template_id": tid, "template_version": 1, "title": "남의 글",
            "blocks": {"h": {"text": "제목"}},
        }).json()["data"]["report_id"]
        rids.append(rid)
        assert c.get(f"/api/reports/{rid}/files", headers=other).status_code == 403
    finally:
        _cleanup(rids, tid)


def test_saved_search_results_uses_the_same_filters_as_subscriptions():
    """실행 결과가 구독 알림과 **같은 필터 경로**를 타야 한다 — 갈라지면
    "알림은 왔는데 열어보니 없다" 가 된다."""
    c = TestClient(app)
    tid = _make_template()
    rids = []
    sid = None
    try:
        rid = c.post("/api/reports/ai-draft", headers=H, json={
            "template_id": tid, "template_version": 1, "title": "저장검색 대상",
            "blocks": {"h": {"text": "제목"}}, "tags": ["저장검색태그"],
        }).json()["data"]["report_id"]
        rids.append(rid)

        made = c.post("/api/saved-searches", headers=H, json={
            "name": "태그 스마트폴더", "query": "",
            "filters": {"tags": ["저장검색태그"]},
        })
        assert made.status_code == 201, made.text
        sid = made.json()["data"]["id"]

        d = c.get(f"/api/saved-searches/{sid}/results", headers=H).json()["data"]
        assert d["saved_search"]["name"] == "태그 스마트폴더"
        ids = [r["report_id"] for r in d["reports"]]
        assert rid in ids, ids
        # 목록 응답 모양은 browse 와 같아야 한다(소비자가 두 벌 배우지 않게).
        row = next(r for r in d["reports"] if r["report_id"] == rid)
        assert {"title", "author", "phase", "tags", "boards", "url"} <= set(row)

        assert c.get("/api/saved-searches/999999/results",
                     headers=H).status_code == 404
    finally:
        if sid:
            c.delete(f"/api/saved-searches/{sid}", headers=H)
        _cleanup(rids, tid)
