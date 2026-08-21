"""빈 화면에서 시작하지 않기 — 프리셋·복제를 AI 에게 연다.

사람은 양식이나 지난 보고서로 시작한다. AI 만 매번 백지에서 구조를 새로 짜면
형식이 흔들리고 토큰도 크게 든다. 백엔드엔 이미 다 있었고 MCP 에만 없었다.

핵심 가드: **AI 가 만든 양식은 기본이 개인 범위**다. `owner_workspace_slugs` 를
생략하면 원래 전사 공개인데(화면에선 사람이 명시적으로 고른다), 자동화가 그 기본을
쓰면 남들 작성 화면 목록이 금방 지저분해진다.

Run: cd backend && ./venv/bin/python -m pytest tests/test_ai_preset_and_copy.py -v
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
        tid = f"preset-{uuid.uuid4().hex[:8]}"
        db.add(Template(
            template_id=tid, version=1, name="preset test", description="", category="misc",
            schema={"version": "widget-v1", "blocks": [
                {"id": "h", "type": "heading", "props": {"label": "제목"}}]},
            owner_workspace_slugs=None, is_published=True, is_latest=True,
            created_by_user_id=None,
        ))
        db.commit()
        return tid
    finally:
        db.close()


def _cleanup(rids, tid, pids=()):
    db = SessionLocal()
    try:
        from app.modules.presets.models import ReportPreset

        for pid in pids:
            pr = db.get(ReportPreset, pid)
            if pr:
                db.delete(pr)
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


def _seed_report(c, tid, title="원본"):
    return c.post("/api/reports/ai-draft", headers=H, json={
        "template_id": tid, "template_version": 1, "title": title,
        "blocks": {"h": {"text": "원본 제목"}},
    }).json()["data"]["report_id"]


def test_ai_preset_defaults_to_personal_scope_not_company_wide():
    """AI 가 범위를 생략하면 **개인 양식**이어야 한다 — 웹은 전사가 기본이다."""
    c = TestClient(app)
    tid = _make_template()
    rids, pids = [], []
    try:
        rid = _seed_report(c, tid)
        rids.append(rid)

        r = c.post("/api/presets", headers=H_MCP, json={
            "source_report_id": rid, "name": "AI 양식", "description": "",
        })
        assert r.status_code == 201, r.text
        pid = r.json()["data"]["id"]
        pids.append(pid)

        from app.modules.presets.models import ReportPreset
        db = SessionLocal()
        try:
            assert db.get(ReportPreset, pid).owner_workspace_slugs == ["personal-1"]
        finally:
            db.close()

        # 웹 경로는 그대로 — 생략하면 전사(None/빈).
        r2 = c.post("/api/presets", headers=H, json={
            "source_report_id": rid, "name": "사람 양식", "description": "",
        })
        assert r2.status_code == 201, r2.text
        pid2 = r2.json()["data"]["id"]
        pids.append(pid2)
        db = SessionLocal()
        try:
            assert not (db.get(ReportPreset, pid2).owner_workspace_slugs or [])
        finally:
            db.close()
    finally:
        _cleanup(rids, tid, pids)


def test_new_report_from_preset_carries_the_seed():
    c = TestClient(app)
    tid = _make_template()
    rids, pids = [], []
    try:
        rid = _seed_report(c, tid, "양식이 될 보고서")
        rids.append(rid)
        pid = c.post("/api/presets", headers=H_MCP, json={
            "source_report_id": rid, "name": "주간 양식", "description": "매주",
        }).json()["data"]["id"]
        pids.append(pid)

        # 목록에 보인다(내 것이므로 scope 무관).
        lst = c.get("/api/presets", headers=H, params={"scope": "all"}).json()["data"]
        assert any(p["id"] == pid for p in lst), [p["id"] for p in lst][:5]

        made = c.post(f"/api/presets/{pid}/new-report", headers=H_MCP,
                      json={"title": "이번 주"})
        assert made.status_code == 201, made.text
        new_id = made.json()["data"]["id"]
        rids.append(new_id)

        d = c.get(f"/api/reports/{new_id}", headers=H).json()["data"]
        assert d["title"] == "이번 주"
        # 양식의 내용이 실제로 실려 왔는가.
        assert d["pages"][0]["content"]["h"], d["pages"][0]["content"]
    finally:
        _cleanup(rids, tid, pids)


def test_copy_report_modes():
    c = TestClient(app)
    tid = _make_template()
    rids = []
    try:
        rid = _seed_report(c, tid, "복제 원본")
        rids.append(rid)
        c.patch(f"/api/reports/{rid}/ai-draft", headers=H,
                json={"tags": ["복제태그"], "page": 1})

        # content — 본문만, 태그는 안 따라온다.
        r = c.post(f"/api/reports/{rid}/copy", headers=H_MCP,
                   json={"title": "사본(content)", "mode": "content"})
        assert r.status_code == 201, r.text
        cid = r.json()["data"]["id"]
        rids.append(cid)
        d = c.get(f"/api/reports/{cid}", headers=H).json()["data"]
        assert d["title"] == "사본(content)"
        assert d["pages"][0]["content"]["h"]
        assert not (d.get("tags") or []), d.get("tags")

        # full — 메타데이터까지.
        r2 = c.post(f"/api/reports/{rid}/copy", headers=H_MCP,
                    json={"title": "사본(full)", "mode": "full"})
        fid = r2.json()["data"]["id"]
        rids.append(fid)
        d2 = c.get(f"/api/reports/{fid}", headers=H).json()["data"]
        assert "복제태그" in (d2.get("tags") or []), d2.get("tags")

        # 사본은 게시를 물려받지 않는다(새 개인 초안).
        assert not (d2.get("mount_workspaces") or [])
    finally:
        _cleanup(rids, tid)
