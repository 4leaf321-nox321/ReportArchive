"""Local LLM 보고서 작성 (report_authoring) — 게이트 + LLM→초안 적용 경로.

report_authoring 엔티틀먼트(§E) 게이트, LLM 응답(JSON blocks)을 기존 AI 초안
파이프라인으로 적용. 실제 LLM 대신 chat 을 패치해 결정적으로 검증.
"""
from __future__ import annotations

import types
import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.reports.models import Report

ADMIN = 2  # bypass → 모든 AI 기능
USER = 3   # 미권한


def _h(uid, slug):
    return {
        "Authorization": f"Bearer {create_access_token(uid)}",
        "X-Workspace-Slug": slug,
    }


def _create_report(c, uid, slug, title):
    tpl = c.get("/api/templates", headers=_h(uid, slug)).json()["data"][0]
    return c.post(
        "/api/reports",
        headers=_h(uid, slug),
        json={
            "template_id": tpl["template_id"],
            "template_version": tpl["version"],
            "title": title,
            "tags": [],
        },
    ).json()["data"]["id"]


def _drop(rid):
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        if r:
            db.delete(r)
            db.commit()
    finally:
        db.close()


def test_llm_author_gate_and_apply(monkeypatch):
    c = TestClient(app)
    rid = _create_report(c, ADMIN, "personal-2", "ORIG " + uuid.uuid4().hex[:5])
    try:
        # 미권한(user3) → 403.
        r3 = c.post(
            f"/api/reports/{rid}/llm-author",
            headers=_h(USER, "dx"),
            json={"instructions": "주간 보고 작성"},
        )
        assert r3.status_code == 403, r3.text

        # chat 패치 — 유효한 JSON(extra_blocks 로 위젯 1개 + 새 제목) → 적용 경로
        # 검증. (빈 템플릿이므로 extra_blocks 로 위젯을 만들어야 실제로 채워진다.)
        def fake_chat(messages, **kw):
            return types.SimpleNamespace(
                content=(
                    '{"title": "AI 생성 제목", "extra_blocks": '
                    '[{"id": "h", "type": "heading", "content": {"text": "개요"}}]}'
                ),
                model="mock",
                backend="mock",
            )

        monkeypatch.setattr("app.ai.llm.chat", fake_chat)

        r = c.post(
            f"/api/reports/{rid}/llm-author",
            headers=_h(ADMIN, "personal-2"),
            json={"instructions": "주간 보고 작성"},
        )
        assert r.status_code == 200, r.text

        # 제목 갱신 + 위젯이 실제로 1개 생겼는지(적용 경로 동작 확인).
        db = SessionLocal()
        try:
            rep = db.get(Report, rid)
            assert rep.title == "AI 생성 제목"
            page = (rep.pages or [{}])[0]
            content = page.get("content") if isinstance(page, dict) else page.content
            assert content, "위젯이 하나도 생성되지 않음"
        finally:
            db.close()
    finally:
        _drop(rid)


def test_llm_author_retries_on_bad_format(monkeypatch):
    """첫 응답이 형식 불량(JSON 없음)이면 자동 재시도 → 다음 응답으로 성공."""
    c = TestClient(app)
    rid = _create_report(c, ADMIN, "personal-2", "RETRY " + uuid.uuid4().hex[:5])
    try:
        calls = {"n": 0}

        def fake_chat(messages, **kw):
            calls["n"] += 1
            content = (
                "죄송합니다, 형식을 잘 모르겠어요."  # 1회차: JSON 없음
                if calls["n"] == 1
                # 2회차: 정상(extra_blocks 로 위젯 1개).
                else (
                    '{"title": "재시도 성공", "extra_blocks": '
                    '[{"id": "h", "type": "heading", "content": {"text": "개요"}}]}'
                )
            )
            return types.SimpleNamespace(
                content=content, model="mock", backend="mock"
            )

        monkeypatch.setattr("app.ai.llm.chat", fake_chat)

        r = c.post(
            f"/api/reports/{rid}/llm-author",
            headers=_h(ADMIN, "personal-2"),
            json={"instructions": "주간 보고 작성"},
        )
        assert r.status_code == 200, r.text
        assert calls["n"] == 2  # 1회 실패 후 재시도
        db = SessionLocal()
        try:
            assert db.get(Report, rid).title == "재시도 성공"
        finally:
            db.close()
    finally:
        _drop(rid)


def _good_chat(messages, **kw):
    return types.SimpleNamespace(
        content=(
            '{"title": "락 작성", "extra_blocks": '
            '[{"id": "h", "type": "heading", "content": {"text": "개요"}}]}'
        ),
        model="mock",
        backend="mock",
    )


def test_llm_author_allows_self_lock(monkeypatch):
    """편집 모드(=본인 락)에서 호출해도 적용된다(allow_self_lock). 사용자가
    직접 호출하고 프론트가 '저장 안 된 편집분 사라질 수 있음'을 고지한다."""
    from app.modules.reports import services

    c = TestClient(app)
    rid = _create_report(c, ADMIN, "personal-2", "SELFLK " + uuid.uuid4().hex[:5])
    try:
        # 본인(ADMIN)이 편집 락을 잡은 상태.
        db = SessionLocal()
        try:
            services.acquire_lock(db, db.get(Report, rid), ADMIN)
            db.commit()
        finally:
            db.close()

        monkeypatch.setattr("app.ai.llm.chat", _good_chat)
        r = c.post(
            f"/api/reports/{rid}/llm-author",
            headers=_h(ADMIN, "personal-2"),
            json={"instructions": "개요 작성"},
        )
        assert r.status_code == 200, r.text  # 본인 락은 통과
    finally:
        _drop(rid)


def test_llm_author_blocks_other_user_lock(monkeypatch):
    """다른 사용자가 편집 락을 잡고 있으면 막는다(409) — 남의 편집 보호."""
    from app.modules.reports import services

    c = TestClient(app)
    rid = _create_report(c, ADMIN, "personal-2", "OTHLK " + uuid.uuid4().hex[:5])
    try:
        # 다른 사용자(USER)가 ADMIN 의 초안에 편집 락을 잡음.
        db = SessionLocal()
        try:
            services.acquire_lock(db, db.get(Report, rid), USER)
            db.commit()
        finally:
            db.close()

        monkeypatch.setattr("app.ai.llm.chat", _good_chat)
        r = c.post(
            f"/api/reports/{rid}/llm-author",
            headers=_h(ADMIN, "personal-2"),
            json={"instructions": "개요 작성"},
        )
        assert r.status_code == 409, r.text  # 다른 사용자 락 → 충돌
    finally:
        _drop(rid)


def test_llm_author_reinterprets_misplaced_blocks(monkeypatch):
    """작은 모델이 extra_blocks 위젯을 blocks(dict)에 잘못 넣어도(빈 템플릿이라
    없는 block_id) extra_block 으로 재해석해 살린다 — 위젯이 실제로 생겨야 한다."""
    c = TestClient(app)
    rid = _create_report(c, ADMIN, "personal-2", "MISP " + uuid.uuid4().hex[:5])
    try:
        def fake_chat(messages, **kw):
            # 빈 템플릿인데 extra_blocks 대신 blocks 에 위젯을 넣음(흔한 실패).
            return types.SimpleNamespace(
                content=(
                    '{"title": "재해석", "blocks": {"sec1": '
                    '{"type": "heading", "content": {"text": "개요"}}}}'
                ),
                model="mock",
                backend="mock",
            )

        monkeypatch.setattr("app.ai.llm.chat", fake_chat)

        r = c.post(
            f"/api/reports/{rid}/llm-author",
            headers=_h(ADMIN, "personal-2"),
            json={"instructions": "개요 작성"},
        )
        assert r.status_code == 200, r.text
        db = SessionLocal()
        try:
            rep = db.get(Report, rid)
            page = (rep.pages or [{}])[0]
            content = page.get("content") if isinstance(page, dict) else page.content
            # 잘못 놓인 위젯이 드롭되지 않고 살아남았는지.
            assert content and any(
                isinstance(v, dict) and v.get("text") == "개요"
                for v in content.values()
            ), f"위젯이 재해석되지 않음: {content}"
        finally:
            db.close()
    finally:
        _drop(rid)
