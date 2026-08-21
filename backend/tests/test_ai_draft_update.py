"""AI 초안 이어쓰기(update_report_draft) + 내 초안 목록(list_my_drafts) 통합 테스트.

생성(POST /ai-draft) → 목록(GET /my-drafts) → 병합/추가/제거/전체교체
(PATCH /{id}/ai-draft) → 권한·상태 가드까지. 자체 템플릿을 만들어 dev DB
상태에 의존하지 않고, 끝에 보고서·템플릿을 정리한다.

Run: cd backend && ./venv/bin/python -m pytest tests/test_ai_draft_update.py -v
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.reports import services
from app.modules.reports.models import Report, ReportPhase
from app.modules.templates.models import Template

H = {
    "Authorization": f"Bearer {create_access_token(1)}",
    "X-Workspace-Slug": "personal-1",
}


def _make_template() -> str:
    """heading + rich_text 두 블록짜리 전역 템플릿(어느 워크스페이스에서나 보임)."""
    db = SessionLocal()
    try:
        tid = f"ai-upd-{uuid.uuid4().hex[:8]}"
        db.add(
            Template(
                template_id=tid,
                version=1,
                name="AI update test",
                description="",
                category="misc",
                schema={
                    "version": "widget-v1",
                    "blocks": [
                        {"id": "heading", "type": "heading", "props": {"label": "제목"}},
                        {"id": "body", "type": "rich_text", "props": {"label": "본문"}},
                    ],
                },
                owner_workspace_slugs=None,  # 전역
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
        # 보고서 먼저(템플릿을 FK 로 참조) — 별도 커밋으로 삭제 순서를 강제.
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


def test_update_draft_merge_list_and_guards():
    c = TestClient(app)
    tid = _make_template()
    rids: list[int] = []
    try:
        # 1) 생성
        r = c.post(
            "/api/reports/ai-draft",
            headers=H,
            json={
                "template_id": tid,
                "template_version": 1,
                "title": "초안",
                "blocks": {"heading": "주간 보고", "body": ["첫 문단", "둘째 문단"]},
            },
        )
        assert r.status_code == 201, r.text
        rid = r.json()["data"]["report_id"]
        rids.append(rid)
        # 생성 응답은 report_id·요약만 준다(모델 토큰 절약) — 본문은 GET 으로.
        lay0 = (
            c.get(f"/api/reports/{rid}", headers=H).json()["data"]["pages"][0]
            .get("layout_overrides")
        )

        # 2) 내 초안 목록에 보임
        r = c.get("/api/reports/my-drafts", headers=H)
        assert r.status_code == 200, r.text
        assert any(d["report_id"] == rid for d in r.json()["data"]["drafts"])

        # 3) 텍스트만 병합 — 안 건드린 블록 유지 + 수동 레이아웃 보존(집합 불변)
        r = c.patch(
            f"/api/reports/{rid}/ai-draft", headers=H, json={"blocks": {"body": ["교체"]}}
        )
        assert r.status_code == 200, r.text
        p = r.json()["data"]["report"]["pages"][0]
        assert "heading" in p["content"]  # 안 준 블록 유지
        assert p.get("layout_overrides") == lay0  # 집합 불변 → 레이아웃 보존

        # 4) extra_blocks 로 위젯 추가 + 제목 변경 (집합 변함)
        r = c.patch(
            f"/api/reports/{rid}/ai-draft",
            headers=H,
            json={
                "title": "제목 변경",
                "extra_blocks": [{"id": "note", "type": "rich_text", "content": "메모"}],
            },
        )
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["report"]["title"] == "제목 변경"
        c0 = d["report"]["pages"][0]["content"]
        assert "note" in c0 and "heading" in c0 and "body" in c0

        # 5) 제거
        r = c.patch(
            f"/api/reports/{rid}/ai-draft", headers=H, json={"remove_blocks": ["note"]}
        )
        assert r.status_code == 200, r.text
        assert "note" not in r.json()["data"]["report"]["pages"][0]["content"]

        # 6) 단락 설정 → 해제 → 잘못된 코드 무시(경고)
        r = c.patch(
            f"/api/reports/{rid}/ai-draft",
            headers=H,
            json={"block_sections": {"heading": "background"}},
        )
        assert r.json()["data"]["report"]["pages"][0]["block_sections"] == {
            "heading": "background"
        }
        r = c.patch(
            f"/api/reports/{rid}/ai-draft",
            headers=H,
            json={"block_sections": {"heading": None}},
        )
        assert r.json()["data"]["report"]["pages"][0]["block_sections"] == {}
        r = c.patch(
            f"/api/reports/{rid}/ai-draft",
            headers=H,
            json={"block_sections": {"heading": "NOPE"}},
        )
        assert any("NOPE" in w for w in r.json()["data"]["warnings"])

        # 6.5) 페이지 추가(append) — page=끝+1 이면 기존 페이지 보존하고 새 쪽 붙임
        before = c.patch(  # 현 상태(1쪽)의 page0 스냅샷
            f"/api/reports/{rid}/ai-draft", headers=H, json={"blocks": {}}
        ).json()["data"]["report"]["pages"][0]
        r = c.patch(
            f"/api/reports/{rid}/ai-draft",
            headers=H,
            json={"page": 2, "blocks": {"heading": "둘째 쪽"}},
        )
        assert r.status_code == 200, r.text
        pages = r.json()["data"]["report"]["pages"]
        assert len(pages) == 2
        assert pages[0] == before  # 1쪽 그대로 보존
        assert pages[1]["content"]["heading"]["text"] == "둘째 쪽"
        # 내용 없이 append 시도 → 400
        assert (
            c.patch(
                f"/api/reports/{rid}/ai-draft", headers=H, json={"page": 3, "blocks": {}}
            ).status_code
            == 400
        )

        # 7) 전체 교체 — 2페이지
        r = c.patch(
            f"/api/reports/{rid}/ai-draft",
            headers=H,
            json={
                "pages": [
                    {"name": "1", "blocks": {"heading": "p1"}},
                    {"name": "2", "blocks": {"heading": "p2"}},
                ]
            },
        )
        assert r.status_code == 200, r.text
        assert len(r.json()["data"]["report"]["pages"]) == 2

        # 7.5) 동시성 — 누군가 편집 락을 잡고 있으면 AI 수정 거부(409), 풀면 다시 허용
        db = SessionLocal()
        rep = db.get(Report, rid)
        services.acquire_lock(db, rep, user_id=4)  # 다른 사용자가 편집 중이라고 가정
        db.commit()
        db.close()
        locked = c.patch(
            f"/api/reports/{rid}/ai-draft", headers=H, json={"blocks": {"heading": "x"}}
        )
        assert locked.status_code == 409, locked.text
        db = SessionLocal()
        rep = db.get(Report, rid)
        services.release_lock(db, rep, user_id=4)
        db.commit()
        db.close()
        unlocked = c.patch(
            f"/api/reports/{rid}/ai-draft", headers=H, json={"blocks": {"heading": "다시 수정"}}
        )
        assert unlocked.status_code == 200, unlocked.text

        # 8) 가드 — 없는 페이지(400)
        assert (
            c.patch(
                f"/api/reports/{rid}/ai-draft", headers=H, json={"page": 9, "blocks": {}}
            ).status_code
            == 400
        )

        # 9) 가드 — 남(소유자 아님) (403)
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

        # 10) 가드 — drafting 아님(발행본) (403)
        db = SessionLocal()
        rep = db.get(Report, rid)
        rep.phase = ReportPhase.finalized
        db.commit()
        db.close()
        assert (
            c.patch(
                f"/api/reports/{rid}/ai-draft", headers=H, json={"blocks": {"heading": "x"}}
            ).status_code
            == 403
        )
    finally:
        _cleanup(rids, tid)
