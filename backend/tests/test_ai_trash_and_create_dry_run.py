"""AI 가 자기 쓰레기를 치울 수 있어야 하고, 애초에 덜 만들어야 한다.

만들기는 쉬운데 치울 방법이 없으면 잘못 만든 초안이 그대로 쌓인다(실제로
점검 중 만든 임시 보고서를 DB 로 직접 지워야 했다). 그렇다고 AI 에게 삭제를
넓게 열면 곤란하므로 **본인 소유 · 미게시 · drafting** 셋을 모두 요구한다.
그리고 `dry_run` 으로 잘못 만드는 것 자체를 줄인다.

Run: cd backend && ./venv/bin/python -m pytest tests/test_ai_trash_and_create_dry_run.py -v
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
H_MCP = {**H, "X-Client": "mcp"}


def _make_template() -> str:
    db = SessionLocal()
    try:
        tid = f"trash-{uuid.uuid4().hex[:8]}"
        db.add(Template(
            template_id=tid, version=1, name="trash test", description="", category="misc",
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


def _create(c, tid, title="휴지통 테스트", **extra):
    return c.post("/api/reports/ai-draft", headers=H_MCP, json={
        "template_id": tid, "template_version": 1, "title": title,
        "blocks": {"h": {"text": "제목"}}, **extra,
    })


def test_create_dry_run_previews_without_creating():
    """미리보기는 **만들지 않는다** — 그게 존재 이유다."""
    c = TestClient(app)
    tid = _make_template()
    try:
        before = c.get("/api/reports/my-drafts", headers=H, params={"limit": 100})
        n_before = len(before.json()["data"]["drafts"])

        r = _create(c, tid, "미리보기만", dry_run=True)
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["dry_run"] is True
        assert d["page_count"] == 1
        assert "h" in d["pages"][0]["blocks"], d["pages"]
        assert d["note"]

        after = c.get("/api/reports/my-drafts", headers=H, params={"limit": 100})
        assert len(after.json()["data"]["drafts"]) == n_before, "미리보기가 보고서를 만들었다"
    finally:
        _cleanup([], tid)


def test_ai_can_trash_its_own_unmounted_draft():
    c = TestClient(app)
    tid = _make_template()
    rids = []
    try:
        rid = _create(c, tid).json()["data"]["report_id"]
        rids.append(rid)
        r = c.post(f"/api/reports/{rid}/trash", headers=H_MCP)
        assert r.status_code == 200, r.text

        db = SessionLocal()
        try:
            assert db.get(Report, rid).deleted_at is not None, "휴지통으로 안 갔다"
        finally:
            db.close()
    finally:
        _cleanup(rids, tid)


def test_ai_cannot_trash_a_mounted_report():
    """게시된 글은 조직이 보고 있다 — 사라지는 것 자체가 사건이라 사람이 판단한다."""
    c = TestClient(app)
    tid = _make_template()
    rids = []
    try:
        rid = _create(c, tid, "게시된 글").json()["data"]["report_id"]
        rids.append(rid)
        m = c.post("/api/mounts", headers=H,
                   json={"report_id": rid, "workspace_slugs": ["dx"]})
        assert m.status_code in (200, 201), m.text

        r = c.post(f"/api/reports/{rid}/trash", headers=H_MCP)
        assert r.status_code == 409, r.text
        msg = r.json().get("message") or ""
        assert "게시" in msg and "웹" in msg, msg  # 어떻게 하면 되는지 알려줘야

        db = SessionLocal()
        try:
            assert db.get(Report, rid).deleted_at is None, "거절했는데 지워졌다"
        finally:
            db.close()

        # 사람(웹)은 여전히 할 수 있다 — 가드는 MCP 경로에만 건다.
        assert c.post(f"/api/reports/{rid}/trash", headers=H).status_code == 200
    finally:
        _cleanup(rids, tid)


def test_ai_cannot_trash_someone_elses_report_even_as_admin():
    """소유자 판정만으론 부족하다 — can_trash_report 는 시스템관리자에게도 열려 있다."""
    c = TestClient(app)
    tid = _make_template()
    rids = []
    try:
        rid = _create(c, tid, "남의 글").json()["data"]["report_id"]
        rids.append(rid)
        db = SessionLocal()
        try:
            db.get(Report, rid).owner_user_id = 2   # 남의 소유로 바꾼다
            db.commit()
        finally:
            db.close()

        # 토큰은 시스템관리자(id 1) — 웹이면 통과하지만 MCP 경로는 막혀야 한다.
        r = c.post(f"/api/reports/{rid}/trash", headers=H_MCP)
        assert r.status_code == 403, r.text
        assert "본인이 쓴" in (r.json().get("message") or "")
    finally:
        _cleanup(rids, tid)
