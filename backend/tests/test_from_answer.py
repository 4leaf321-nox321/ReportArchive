"""검색 답변 → 보고서 초안 저장 (POST /api/reports/from-answer).

report_authoring 게이트 + 2차 LLM 패스(위젯 JSON) → create_ai_draft 경로. 실제 LLM
대신 chat_cancellable 을 async fake 로 패치해 결정적으로 검증한다(차트 위젯 포함).
"""
from __future__ import annotations

import types
import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.reports.models import Report

ADMIN = 2  # bypass → 모든 AI 기능(report_authoring 포함)
USER = 3   # 미권한

# LLM 이 낼 법한 응답 — 본문 + **차트 위젯**(bar). 차트가 정규화·검증 파이프라인을
# 통과해 초안에 실제로 들어가는지 확인한다.
_ANSWER_JSON = (
    '{"title": "낙하 취약 부품", "extra_blocks": ['
    '{"id": "h", "type": "heading", "content": {"text": "결론"}},'
    '{"id": "b", "type": "rich_text", "content": "힌지 브래킷이 가장 취약."},'
    '{"id": "c", "type": "chart", "props": {"chart_type": "bar", '
    '"x_column_key": "part", "columns": ['
    '{"key": "part", "label": "부품", "type": "text"},'
    '{"key": "rpn", "label": "RPN", "type": "number"}]}, '
    '"content": {"rows": [{"part": "힌지", "rpn": 320}, {"part": "마운트", "rpn": 180}]}}'
    "]}"
)


def _h(uid, slug):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": slug,
    }


def _drop(rid):
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        if r:
            db.delete(r)
            db.commit()
    finally:
        db.close()


def test_from_answer_requires_report_authoring():
    c = TestClient(app)
    r = c.post(
        "/api/reports/from-answer",
        headers=_h(USER, "dx"),
        json={"question": "취약 부품?", "answer": "힌지."},
    )
    assert r.status_code == 403, r.text


def test_from_answer_creates_draft_with_chart(monkeypatch):
    c = TestClient(app)

    async def fake_chat(messages, **kw):
        return types.SimpleNamespace(content=_ANSWER_JSON, model="mock", backend="mock")

    monkeypatch.setattr("app.ai.llm.chat_cancellable", fake_chat)

    r = c.post(
        "/api/reports/from-answer",
        headers=_h(ADMIN, "personal-2"),
        json={
            "question": "낙하 시험에서 가장 취약한 부품은? " + uuid.uuid4().hex[:5],
            "answer": "힌지 브래킷이 가장 취약합니다.",
            "citations": [{"n": 1, "title": "낙하시험 보고서", "snippet": "요약..."}],
        },
    )
    assert r.status_code == 201, r.text
    data = r.json()["data"]
    assert data.get("url"), data
    rid = data["report"]["id"]
    try:
        db = SessionLocal()
        try:
            rep = db.get(Report, rid)
            assert rep is not None
            assert rep.title == "낙하 취약 부품"
            page = (rep.pages or [{}])[0]
            if isinstance(page, dict):
                extras = page.get("extra_blocks") or []
                content = page.get("content")
            else:
                extras = page.extra_blocks or []
                content = page.content
            assert content, "위젯이 하나도 생성되지 않음"
            types_ = {e.get("type") for e in extras if isinstance(e, dict)}
            assert "chart" in types_, f"차트 위젯이 초안에 없음: {types_}"
        finally:
            db.close()
    finally:
        _drop(rid)
