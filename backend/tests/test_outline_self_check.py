"""자기 점검(outline) — AI 는 완성 화면을 못 본다. 이게 유일한 눈이다.

예전엔 `rows`/`items`/`text` 만 보고 나머지 dict 는 `bool(dict)` 로 판정해서,
**빈 이미지·빈 차트가 전부 "채워짐"으로** 보고됐다(위젯 content 는 모양이
제각각이다 — sankey=links, network=edges, density=groups, image=files).
타입을 열거하지 않고 **모양으로** 본다.

Run: cd backend && ./venv/bin/python -m pytest tests/test_outline_self_check.py -v
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.reports.models import Report
from app.modules.reports.routes import _block_fill
from app.modules.templates.models import Template

H = {
    "Authorization": f"Bearer {create_access_token(1)}",
    "X-Workspace-Slug": "personal-1",
}


def test_block_fill_sees_empty_widgets_of_any_shape():
    """모양이 달라도 **빈 것은 비었다고** 해야 한다 — 오탐이 곧 AI 의 눈먼 곳이다."""
    empty = {
        "sankey": {"links": [], "caption_skip_autofill": False},
        "network": {"edges": [], "nodes": []},
        "density": {"groups": [], "show_dots": True},
        "quadrant": {"mode": "plot", "plot_items": [], "bucket_items": []},
        "image": {"files": []},
        "meta": {"solver": "", "analyst": ""},
        "table": {"rows": []},
    }
    for name, content in empty.items():
        assert _block_fill(content)["filled"] is False, (name, content)

    filled = {
        "sankey": {"links": [{"a": 1}]},
        "network": {"edges": [{"s": 1}], "nodes": []},
        "image": {"files": [{"file_id": "x"}]},
        "meta": {"solver": "Abaqus", "analyst": ""},
        "table": {"rows": [{"a": 1}]},
        "text": {"text": "내용"},
    }
    for name, content in filled.items():
        assert _block_fill(content)["filled"] is True, (name, content)


def _make_template() -> str:
    db = SessionLocal()
    try:
        tid = f"outline-{uuid.uuid4().hex[:8]}"
        db.add(Template(
            template_id=tid, version=1, name="outline", description="", category="misc",
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


def test_outline_flags_broken_file_refs_and_thin_content():
    c = TestClient(app)
    tid = _make_template()
    rids = []
    try:
        rid = c.post("/api/reports/ai-draft", headers=H, json={
            "template_id": tid, "template_version": 1, "title": "자기 점검",
            "blocks": {"h": {"text": "제목"}},
            "extra_blocks": [
                # 이미지 한 장 — 정상이지만 파일이 없다(깨진 참조).
                {"id": "img", "type": "image", "props": {"max_count": 1},
                 "content": {"files": [{"file_id": "does-not-exist"}]}},
                # 표인데 한 줄뿐 — 만들다 만 것으로 의심된다.
                {"id": "tbl", "type": "table",
                 "props": {"columns": [{"key": "a", "label": "A", "type": "text"}]},
                 "content": [{"a": "1"}]},
            ],
        }).json()["data"]["report_id"]
        rids.append(rid)

        issues = c.get(f"/api/reports/{rid}/outline", headers=H).json()["data"]["issues"]
        joined = " / ".join(issues)
        assert "파일이 없습니다" in joined, issues
        thin = [i for i in issues if "값이 하나뿐입니다" in i]
        assert any("'tbl'" in i for i in thin), issues
        # 이미지 한 장은 지극히 정상 — 얇다고 경고하면 안 된다(_SINGLE_VALUE_OK).
        assert not any("'img'" in i for i in thin), issues
    finally:
        _cleanup(rids, tid)
