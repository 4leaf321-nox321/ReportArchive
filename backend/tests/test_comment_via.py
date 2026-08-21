"""댓글 작성 경로(via) 표식 — 사람이 쓴 것과 AI(MCP)가 쓴 것을 구분한다.

MCP 는 **사용자의 토큰으로** 동작해서 인증 정보만으론 구분이 안 된다. 표식이
없으면 AI 답글이 그 사람이 직접 쓴 것처럼 보여 협업 신뢰가 깨진다. 백엔드가
요청 헤더 `X-Client: mcp` 를 보고 정한다(보안 경계가 아니라 표시용 표식).

Run: cd backend && ./venv/bin/python -m pytest tests/test_comment_via.py -v
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
        tid = f"via-{uuid.uuid4().hex[:8]}"
        db.add(
            Template(
                template_id=tid, version=1, name="via test", description="",
                category="misc",
                schema={"version": "widget-v1", "blocks": [
                    {"id": "h", "type": "heading", "props": {"label": "제목"}}]},
                owner_workspace_slugs=None, is_published=True, is_latest=True,
                created_by_user_id=None,
            )
        )
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


def _doc(text):
    return {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": text}]}]}


def test_comment_via_marks_ai_authored():
    c = TestClient(app)
    tid = _make_template()
    rids = []
    try:
        r = c.post("/api/reports/ai-draft", headers=H, json={
            "template_id": tid, "template_version": 1, "title": "via",
            "blocks": {"h": "제목"}})
        assert r.status_code == 201, r.text
        rid = r.json()["data"]["report"]["id"]
        rids.append(rid)

        # 사람이 웹에서 스레드를 연다 → via='web'
        t = c.post(f"/api/reports/{rid}/threads", headers=H, json={
            "page_index": 0, "block_id": "h", "body": _doc("근거 보강 부탁")})
        assert t.status_code in (200, 201), t.text
        thread_id = t.json()["data"]["id"]
        assert t.json()["data"]["comments"][0]["via"] == "web"

        # AI(MCP)가 답글 → via='mcp'
        a = c.post(f"/api/threads/{thread_id}/comments", headers=H_MCP,
                   json={"body": _doc("반영했습니다")})
        assert a.status_code in (200, 201), a.text
        assert a.json()["data"]["via"] == "mcp"

        # 같은 사람이 웹에서 또 달면 다시 'web' — 계정이 아니라 경로로 갈린다
        w = c.post(f"/api/threads/{thread_id}/comments", headers=H,
                   json={"body": _doc("확인했습니다")})
        assert w.json()["data"]["via"] == "web"

        # 목록에서도 순서대로 구분된다
        data = c.get(f"/api/reports/{rid}/threads", headers=H).json()["data"]
        th = next(x for x in data["items"] if x["id"] == thread_id)
        assert [x["via"] for x in th["comments"]] == ["web", "mcp", "web"]

        # 위조 방어가 목적이 아니므로 아무 값이나 오면 'web' 으로 떨어진다
        o = c.post(f"/api/threads/{thread_id}/comments",
                   headers={**H, "X-Client": "something-else"},
                   json={"body": _doc("기타 클라이언트")})
        assert o.json()["data"]["via"] == "web"
    finally:
        _cleanup(rids, tid)
