"""게시 2단계 확인 — AI(MCP) 경로만 미리보기 토큰을 요구한다.

게시(mount)는 되돌리기 어려운 **바깥 방향** 행위다. 문서가 조직에 보이고,
내리려면 게시판 매니저 승인이 필요하다. 웹에서는 사람이 대상 게시판을 눈으로
고르지만 AI 는 이름을 잘못 해석해 엉뚱한(특히 상위 부문) 게시판에 올릴 수 있다.
그래서 MCP 경로만 preview → confirm 2단계를 강제한다(웹은 그대로 한 번에).

Run: cd backend && ./venv/bin/python -m pytest tests/test_mount_confirm.py -v
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.mounts import confirm as mount_confirm
from app.modules.reports.models import Report
from app.modules.templates.models import Template

BOARD, OTHER = "dev-hw", "dev-he"
H = {"Authorization": f"Bearer {create_access_token(1)}",
     "X-Workspace-Slug": "personal-1"}
H_MCP = {**H, "X-Client": "mcp"}


def _make_template() -> str:
    db = SessionLocal()
    try:
        tid = f"pub-{uuid.uuid4().hex[:8]}"
        db.add(Template(
            template_id=tid, version=1, name="publish", description="", category="misc",
            schema={"version": "widget-v1", "blocks": [
                {"id": "h", "type": "heading", "props": {"label": "제목"}}]},
            owner_workspace_slugs=None, is_published=True, is_latest=True,
            created_by_user_id=None))
        db.commit()
        return tid
    finally:
        db.close()


def _cleanup(rids, tid):
    c = TestClient(app)
    for rid in rids:
        for b in (BOARD, OTHER):
            c.delete(f"/api/mounts/{rid}/{b}", headers=H)
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


def test_token_binds_to_user_report_and_boards():
    """토큰은 (사용자, 보고서, 게시판 집합)에 묶인다 — 순수 함수 검증."""
    t = mount_confirm.issue(1, 42, ["dx", "dev"])
    assert mount_confirm.verify(t, 1, 42, ["dev", "dx"]) is None  # 순서 무관
    assert mount_confirm.verify(t, 1, 43, ["dx", "dev"])          # 다른 보고서
    assert mount_confirm.verify(t, 1, 42, ["dx"])                 # 다른 게시판
    assert mount_confirm.verify(t, 2, 42, ["dx", "dev"])          # 다른 사용자
    assert mount_confirm.verify(None, 1, 42, ["dx"])              # 토큰 없음
    assert mount_confirm.verify("garbage", 1, 42, ["dx"])         # 형식 오류


def test_mcp_publish_requires_preview_but_web_does_not():
    c = TestClient(app)
    tid = _make_template()
    rids = []
    try:
        r = c.post("/api/reports/ai-draft", headers=H, json={
            "template_id": tid, "template_version": 1, "title": "게시 확인",
            "blocks": {"h": "제목"}})
        rid = r.json()["data"]["report"]["id"]
        rids.append(rid)

        # MCP 는 토큰 없이 게시 불가
        no = c.post("/api/mounts", headers=H_MCP,
                    json={"report_id": rid, "workspace_slugs": [BOARD]})
        assert no.status_code == 400
        assert "미리보기" in no.json()["message"]

        # 미리보기 — 실제로 게시되지 않고, 어디에 얼마나 보이는지 알려준다
        pv = c.post("/api/mounts/preview", headers=H_MCP,
                    json={"report_id": rid, "workspace_slugs": [BOARD]})
        assert pv.status_code == 200, pv.text
        d = pv.json()["data"]
        tgt = d["targets"][0]
        assert tgt["slug"] == BOARD and tgt["name"]
        assert tgt["audience"] > 0 and tgt["already_mounted"] is False
        assert d["confirm_token"]
        assert c.get(f"/api/mounts?report_id={rid}", headers=H).json()["data"]["items"] == []

        # 미리 본 것과 다른 게시판으로는 못 올린다
        wrong = c.post("/api/mounts", headers=H_MCP, json={
            "report_id": rid, "workspace_slugs": [OTHER],
            "confirm_token": d["confirm_token"]})
        assert wrong.status_code == 400
        assert "맞지 않습니다" in wrong.json()["message"]

        # 확인 후 게시 → via='mcp'
        okr = c.post("/api/mounts", headers=H_MCP, json={
            "report_id": rid, "workspace_slugs": [BOARD],
            "confirm_token": d["confirm_token"]})
        assert okr.status_code == 200, okr.text
        items = c.get(f"/api/mounts?report_id={rid}", headers=H).json()["data"]["items"]
        assert next(x for x in items if x["workspace_slug"] == BOARD)["via"] == "mcp"

        # 사람(웹)은 토큰 없이 그대로 한 번에 — 2단계는 AI 경로만
        w = c.post("/api/mounts", headers=H,
                   json={"report_id": rid, "workspace_slugs": [OTHER]})
        assert w.status_code == 200, w.text
        items = c.get(f"/api/mounts?report_id={rid}", headers=H).json()["data"]["items"]
        assert next(x for x in items if x["workspace_slug"] == OTHER)["via"] == "web"
    finally:
        _cleanup(rids, tid)
