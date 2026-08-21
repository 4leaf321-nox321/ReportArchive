"""게시(mount)된 보고서를 MCP/AI 로 이어서 수정 — 가드 정렬 회귀 테스트.

배경: 게시하면 phase 가 drafting→reviewing 으로 자동 승격되는데(mounts/services),
PATCH /ai-draft 가 "소유자 AND drafting" 만 허용해 **게시한 순간 AI 수정이 영영
막혔다**(같은 사용자가 웹에선 멀쩡히 고칠 수 있는데도). 가드를 사람 경로
(PATCH /reports/{id})와 같은 규칙(can_edit + finalized 차단)으로 정렬한 것을 검증.

확인 대상:
  - 게시된(reviewing) 보고서 PATCH /ai-draft → 200, 응답 mounted_to 에 게시판·폴더
  - 발행본(finalized) → 403 (사람 경로와 동일하게 유지)
  - 남의 보고서 → 403 (권한 가드는 그대로)
  - GET /my-drafts: 기본(all)엔 게시분 포함·editable=True, phase=drafting 이면 제외

Run: cd backend && ./venv/bin/python -m pytest tests/test_ai_draft_published.py -v
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.reports.models import Report, ReportPhase
from app.modules.templates.models import Template

BOARD = "dev-hw"
H = {
    "Authorization": f"Bearer {create_access_token(1)}",
    "X-Workspace-Slug": "personal-1",
}


def _make_template() -> str:
    db = SessionLocal()
    try:
        tid = f"ai-pub-{uuid.uuid4().hex[:8]}"
        db.add(
            Template(
                template_id=tid,
                version=1,
                name="AI published test",
                description="",
                category="misc",
                schema={
                    "version": "widget-v1",
                    "blocks": [
                        {"id": "heading", "type": "heading", "props": {"label": "제목"}},
                        {"id": "body", "type": "rich_text", "props": {"label": "본문"}},
                    ],
                },
                owner_workspace_slugs=None,
                is_published=True,
                is_latest=True,
                created_by_user_id=None,
            )
        )
        db.commit()
        return tid
    finally:
        db.close()


def _cleanup(report_ids, template_id) -> None:
    db = SessionLocal()
    try:
        for rid in report_ids:
            r = db.get(Report, rid)
            if r:
                db.delete(r)
        db.commit()
        t = db.get(Template, (template_id, 1))
        if t:
            db.delete(t)
            db.commit()
    finally:
        db.close()


def _phase(rid: int) -> str:
    db = SessionLocal()
    try:
        return db.get(Report, rid).phase.value
    finally:
        db.close()


def test_ai_can_edit_mounted_report():
    c = TestClient(app)
    tid = _make_template()
    rids: list[int] = []
    try:
        # 1) 초안 생성
        r = c.post(
            "/api/reports/ai-draft",
            headers=H,
            json={
                "template_id": tid,
                "template_version": 1,
                "title": "게시 예정 보고",
                "blocks": {"heading": "초기 제목", "body": ["초기 본문"]},
            },
        )
        assert r.status_code == 201, r.text
        rid = r.json()["data"]["report"]["id"]
        rids.append(rid)
        assert _phase(rid) == "drafting"

        # 2) 게시(mount) → phase 가 reviewing 으로 자동 승격된다
        m = c.post(
            "/api/mounts",
            headers=H,
            json={"report_id": rid, "workspace_slugs": [BOARD]},
        )
        assert m.status_code == 200, m.text
        assert _phase(rid) == "reviewing"

        # 3) 핵심 — 게시된 글도 AI 로 수정된다(예전엔 403)
        r = c.patch(
            f"/api/reports/{rid}/ai-draft",
            headers=H,
            json={"blocks": {"body": ["게시 후 보강한 본문"]}},
        )
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        assert (
            data["report"]["pages"][0]["content"]["body"]["items"][0]["text"]
            == "게시 후 보강한 본문"
        )
        # 응답이 게시 위치를 알려준다 — AI 가 "이 글은 이미 게시돼 있습니다" 고지용
        slugs = [b["slug"] for b in data["mounted_to"]]
        assert BOARD in slugs
        assert "folders" in data["mounted_to"][0]

        # 4) /my-drafts — 기본(all)엔 게시분이 보이고 editable, drafting 엔 안 보임
        rows = c.get("/api/reports/my-drafts?limit=100", headers=H).json()["data"]["drafts"]
        row = next((d for d in rows if d["report_id"] == rid), None)
        assert row is not None, "게시된 내 글이 목록에 없다"
        assert row["phase"] == "reviewing"
        assert row["editable"] is True
        assert BOARD in [b["slug"] for b in row["mounted_to"]]
        only_draft = c.get(
            "/api/reports/my-drafts?limit=100&phase=drafting", headers=H
        ).json()["data"]["drafts"]
        assert all(d["report_id"] != rid for d in only_draft)

        # 5) 발행본은 여전히 막힌다(사람 경로와 동일 규칙)
        db = SessionLocal()
        db.get(Report, rid).phase = ReportPhase.finalized
        db.commit()
        db.close()
        blocked = c.patch(
            f"/api/reports/{rid}/ai-draft", headers=H, json={"blocks": {"heading": "x"}}
        )
        assert blocked.status_code == 403, blocked.text
        assert "발행" in blocked.json()["message"]
        # 발행본은 editable=False 로 표시
        rows = c.get("/api/reports/my-drafts?limit=100", headers=H).json()["data"]["drafts"]
        row = next(d for d in rows if d["report_id"] == rid)
        assert row["editable"] is False

        # 6) 권한 가드는 그대로 — 남의 보고서는 403
        db = SessionLocal()
        db.get(Report, rid).phase = ReportPhase.reviewing
        db.commit()
        db.close()
        h4 = {
            "Authorization": f"Bearer {create_access_token(4)}",
            "X-Workspace-Slug": "personal-4",
        }
        assert (
            c.patch(
                f"/api/reports/{rid}/ai-draft", headers=h4, json={"blocks": {"heading": "x"}}
            ).status_code
            == 403
        )
    finally:
        _cleanup(rids, tid)
