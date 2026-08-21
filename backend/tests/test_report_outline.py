"""보고서 구조 요약(outline) — AI 자기 점검용.

AI(MCP)는 완성된 화면을 볼 수 없어서, 만든 보고서에 빈 표나 데이터 없는 차트가
남아도 알아채지 못한다. 본문을 통째로 읽으면 토큰을 크게 먹으므로 "무엇이 있고
무엇이 비었나"만 돌려주는 경로다.

Run: cd backend && ./venv/bin/python -m pytest tests/test_report_outline.py -v
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
        tid = f"outline-{uuid.uuid4().hex[:8]}"
        db.add(Template(
            template_id=tid, version=1, name="outline", description="", category="misc",
            schema={"version": "widget-v1", "blocks": [
                {"id": "a", "type": "heading", "props": {"label": "제목"}},
                {"id": "b", "type": "table", "props": {"columns": [
                    {"key": "k", "label": "K", "type": "text"}]}},
            ]},
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


def test_outline_flags_empty_visible_blocks():
    c = TestClient(app)
    tid = _make_template()
    rids = []
    try:
        # 일반 생성 경로 — blocks_order 가 없어 템플릿 블록이 모두 '보이는' 상태.
        r = c.post("/api/reports", headers=H, json={
            "template_id": tid, "template_version": 1, "title": "outline",
            "content": {"a": {"text": "제목만 채움"}}})
        assert r.status_code in (200, 201), r.text
        rid = r.json()["data"]["id"]
        rids.append(rid)

        o = c.get(f"/api/reports/{rid}/outline", headers=H).json()["data"]
        assert o["page_count"] == 1
        blocks = {b["block_id"]: b for b in o["pages"][0]["blocks"]}
        assert blocks["a"]["filled"] is True and blocks["a"]["type"] == "heading"
        assert blocks["b"]["filled"] is False and blocks["b"]["type"] == "table"
        # 보이는데 빈 블록은 issues 로 올라온다 — AI 가 스스로 잡게
        assert any("'b'" in i for i in o["issues"]), o["issues"]
        assert not any("'a'" in i for i in o["issues"])
        # 본문은 담지 않는다(토큰 절약이 존재 이유)
        assert "content" not in o["pages"][0]
        assert "mounted_to" in o

        # 다 채운 보고서는 issue 가 없고 행 수가 보인다
        # (PATCH /reports/{id} 는 편집 락이 필요하므로 생성 시점에 채운다)
        r2 = c.post("/api/reports", headers=H, json={
            "template_id": tid, "template_version": 1, "title": "outline 완성",
            "content": {"a": {"text": "제목"},
                        "b": {"rows": [{"k": "값1"}, {"k": "값2"}]}}})
        assert r2.status_code in (200, 201), r2.text
        rid2 = r2.json()["data"]["id"]
        rids.append(rid2)
        o2 = c.get(f"/api/reports/{rid2}/outline", headers=H).json()["data"]
        b2 = {b["block_id"]: b for b in o2["pages"][0]["blocks"]}
        assert b2["b"]["rows"] == 2 and b2["b"]["filled"] is True, b2["b"]
        assert o2["issues"] == [], o2["issues"]

        # 보기 권한 없는 사람은 못 본다
        h4 = {"Authorization": f"Bearer {create_access_token(4)}",
              "X-Workspace-Slug": "personal-4"}
        assert c.get(f"/api/reports/{rid}/outline", headers=h4).status_code == 403
    finally:
        _cleanup(rids, tid)
