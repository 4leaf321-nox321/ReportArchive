"""위젯 행 단위 수정(MCP) — 표에 한 줄 추가·셀만 수정·행 삭제.

기존 `PATCH /ai-draft` 의 `blocks` 는 블록 content 를 **통째로 교체**한다. 그래서
한 줄을 바꾸려 해도 AI 가 표 전체를 읽어 전부 다시 보내야 했다(토큰 낭비 + 읽고
쓰는 사이 사람이 고친 걸 덮어쓸 위험). 이 경로는 서버가 현재 값을 읽어 부분만 바꾼다.

Run: cd backend && ./venv/bin/python -m pytest tests/test_ai_row_ops.py -v
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
        tid = f"rowops-{uuid.uuid4().hex[:8]}"
        db.add(Template(
            template_id=tid, version=1, name="row ops", description="", category="misc",
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


def test_row_level_edits():
    c = TestClient(app)
    tid = _make_template()
    rids = []
    try:
        r = c.post("/api/reports/ai-draft", headers=H, json={
            "template_id": tid, "template_version": 1, "title": "행 연산",
            "blocks": {},
            "extra_blocks": [{
                "id": "t", "type": "table",
                "props": {"columns": [
                    {"key": "item", "label": "항목", "type": "text"},
                    {"key": "qty", "label": "수량", "type": "number"}]},
                "content": [{"item": "원자재", "qty": 100}, {"item": "인건비", "qty": 50}],
            }],
        })
        assert r.status_code == 201, r.text
        rid = r.json()["data"]["report"]["id"]
        rids.append(rid)

        def rows():
            d = c.get(f"/api/reports/{rid}", headers=H).json()["data"]
            return d["pages"][0]["content"]["t"]["rows"], d["revision"]

        assert len(rows()[0]) == 2

        # 추가 — 기존 행은 그대로
        a = c.patch(f"/api/reports/{rid}/ai-draft/rows", headers=H, json={
            "page": 1, "ops": [{"block_id": "t", "op": "append",
                                "rows": [{"item": "물류비", "qty": 30}]}]})
        assert a.status_code == 200, a.text
        got, rev = rows()
        assert [x["item"] for x in got] == ["원자재", "인건비", "물류비"]
        assert got[0]["qty"] == 100

        # 셀만 수정 — 같은 행의 다른 열도 유지
        c.patch(f"/api/reports/{rid}/ai-draft/rows", headers=H, json={
            "page": 1, "ops": [{"block_id": "t", "op": "patch",
                                "patches": [{"row": 1, "key": "qty", "value": 75}]}]})
        got, rev = rows()
        assert got[1] == {"item": "인건비", "qty": 75} or got[1]["qty"] == 75, got[1]
        assert got[1]["item"] == "인건비"

        # dry_run — 적용되지 않는다
        d = c.patch(f"/api/reports/{rid}/ai-draft/rows", headers=H, json={
            "page": 1, "dry_run": True,
            "ops": [{"block_id": "t", "op": "remove", "indexes": [0]}]})
        assert d.json()["data"]["dry_run"] is True
        assert d.json()["data"]["row_counts"]["t"] == 2
        assert len(rows()[0]) == 3, "dry_run 인데 저장됨"

        # 삭제
        c.patch(f"/api/reports/{rid}/ai-draft/rows", headers=H, json={
            "page": 1, "ops": [{"block_id": "t", "op": "remove", "indexes": [0]}]})
        got, rev = rows()
        assert [x["item"] for x in got] == ["인건비", "물류비"]

        # 여러 연산을 한 번에 — 순서대로 적용되고 한 번만 저장된다
        before_rev = rev
        c.patch(f"/api/reports/{rid}/ai-draft/rows", headers=H, json={
            "page": 1, "ops": [
                {"block_id": "t", "op": "append", "rows": [{"item": "A", "qty": 1}]},
                {"block_id": "t", "op": "patch", "patches": [{"row": 0, "key": "qty", "value": 9}]},
            ]})
        got, rev = rows()
        assert [x["item"] for x in got] == ["인건비", "물류비", "A"]
        assert got[0]["qty"] == 9
        assert rev == before_rev + 1, f"저장은 한 번이어야: {before_rev}→{rev}"

        # 낙관적 동시성 — 낡은 revision 이면 거부
        stale = c.patch(f"/api/reports/{rid}/ai-draft/rows", headers=H, json={
            "page": 1, "expected_revision": 1,
            "ops": [{"block_id": "t", "op": "append", "rows": [{"item": "x"}]}]})
        assert stale.status_code == 409, stale.status_code

        # 행이 없는 위젯·없는 블록은 400 + 가능한 블록 안내
        bad = c.patch(f"/api/reports/{rid}/ai-draft/rows", headers=H, json={
            "page": 1, "ops": [{"block_id": "h", "op": "append", "rows": [{"a": 1}]}]})
        assert bad.status_code == 400
        assert "'t'" in bad.json()["message"], bad.json()["message"]

        # 범위 밖 행 번호
        oob = c.patch(f"/api/reports/{rid}/ai-draft/rows", headers=H, json={
            "page": 1, "ops": [{"block_id": "t", "op": "patch",
                                "patches": [{"row": 99, "key": "qty", "value": 1}]}]})
        assert oob.status_code == 400

        # 버전 이력에 AI 표식이 남는다
        versions = c.get(f"/api/reports/{rid}/versions", headers=H).json()["data"]
        assert "mcp" in [v["source"] for v in versions]
    finally:
        _cleanup(rids, tid)
