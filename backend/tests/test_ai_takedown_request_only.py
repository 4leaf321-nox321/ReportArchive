"""AI 의 게시취소는 **요청까지만** — 매니저 권한이 있어도 즉시 내리지 않는다.

게시는 조직 전체에 문서를 노출시키는 행위라 2단계 확인을 붙였는데, 반대 방향은
아예 열려 있지 않았다(가이드가 "웹에서 하라"고 사람에게 넘겼다). 이제 요청은
넣을 수 있되, **사람이 보고 있던 문서가 사라지는 일**이므로 승인은 사람이 한다.
웹 경로는 그대로다 — 매니저가 화면에서 누르면 여전히 즉시 내려간다.

Run: cd backend && ./venv/bin/python -m pytest tests/test_ai_takedown_request_only.py -v
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.mounts.models import ReportMount, ReportTakedownRequest
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
        tid = f"takedown-{uuid.uuid4().hex[:8]}"
        db.add(Template(
            template_id=tid, version=1, name="takedown", description="", category="misc",
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
            db.query(ReportTakedownRequest).filter_by(report_id=rid).delete()
            db.query(ReportMount).filter_by(report_id=rid).delete()
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


def _mounted_report(c, tid, title):
    rid = c.post("/api/reports/ai-draft", headers=H, json={
        "template_id": tid, "template_version": 1, "title": title,
        "blocks": {"h": {"text": "제목"}},
    }).json()["data"]["report_id"]
    m = c.post("/api/mounts", headers=H,
               json={"report_id": rid, "workspace_slugs": ["dx"]})
    assert m.status_code in (200, 201), m.text
    return rid


def _is_mounted(rid) -> bool:
    db = SessionLocal()
    try:
        return db.query(ReportMount).filter_by(report_id=rid).count() > 0
    finally:
        db.close()


def test_mcp_takedown_never_removes_immediately():
    """관리자(=dx 매니저 권한 보유) 토큰이어도 MCP 경로는 pending 만 만든다."""
    c = TestClient(app)
    tid = _make_template()
    rids = []
    try:
        rid = _mounted_report(c, tid, "AI 내리기 요청")
        rids.append(rid)

        r = c.post(f"/api/reports/{rid}/takedown-requests?workspace_slug=dx",
                   headers=H_MCP)
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["auto_removed"] == 0, d
        assert d["requested"] == 1, d
        assert d.get("withheld_auto") == ["dx"], d   # 웹에서 승인하라고 알려줘야
        assert _is_mounted(rid), "AI 요청인데 즉시 내려갔다"

        db = SessionLocal()
        try:
            q = db.query(ReportTakedownRequest).filter_by(report_id=rid)
            assert q.count() == 1
            assert q.first().status.value == "pending"
        finally:
            db.close()
    finally:
        _cleanup(rids, tid)


def test_web_takedown_still_removes_immediately_for_managers():
    """웹 경로는 바뀌면 안 된다 — 가드는 MCP 경로에만 건다."""
    c = TestClient(app)
    tid = _make_template()
    rids = []
    try:
        rid = _mounted_report(c, tid, "사람이 내리기")
        rids.append(rid)

        r = c.post(f"/api/reports/{rid}/takedown-requests?workspace_slug=dx", headers=H)
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["auto_removed"] == 1, d
        assert "withheld_auto" not in d, d
        assert not _is_mounted(rid), "매니저가 웹에서 눌렀는데 안 내려갔다"
    finally:
        _cleanup(rids, tid)
