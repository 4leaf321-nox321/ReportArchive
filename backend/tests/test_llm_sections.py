"""Local LLM 단락구분(section) 자동 지정 — 게이트 + LLM→block_sections 적용.

report_authoring 엔티틀먼트 게이트(§E), 각 위젯 텍스트 + 코드 목록을 LLM 에 주고
{번호: code} 를 받아 page.block_sections 에 반영. 실제 LLM 대신 chat_cancellable
(비동기)을 패치해 결정적으로 검증. overwrite(빈 것만/전부)·잘못된 code 무시도 확인.
"""
from __future__ import annotations

import types
import uuid

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.reports.models import Report
from app.modules.section_taxonomy.models import SectionCategory, SectionItem

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


def _seed_code(suffix):
    """테스트용 단락구분 코드 하나 등록 → code 반환."""
    code = f"trisk_{suffix}"
    db = SessionLocal()
    try:
        db.add(
            SectionCategory(slug=f"tc_{suffix}", name="테스트", color="#123456", sort_order=999)
        )
        db.flush()
        db.add(
            SectionItem(code=code, category_slug=f"tc_{suffix}", label="리스크", sort_order=0)
        )
        db.commit()
    finally:
        db.close()
    return code


def _set_content(rid, content, block_sections=None):
    db = SessionLocal()
    try:
        rep = db.get(Report, rid)
        pages = list(rep.pages or [{}])
        page = dict(pages[0]) if pages else {}
        page["content"] = content
        page["block_sections"] = block_sections or {}
        rep.pages = [page]
        db.commit()
    finally:
        db.close()


def _block_sections(rid):
    db = SessionLocal()
    try:
        rep = db.get(Report, rid)
        return dict((rep.pages[0] or {}).get("block_sections") or {})
    finally:
        db.close()


def _cleanup(rid, suffix):
    db = SessionLocal()
    try:
        r = db.get(Report, rid)
        if r:
            db.delete(r)
        db.query(SectionItem).filter_by(code=f"trisk_{suffix}").delete()
        db.query(SectionCategory).filter_by(slug=f"tc_{suffix}").delete()
        db.commit()
    finally:
        db.close()


def test_llm_sections_gate_and_assign(monkeypatch):
    c = TestClient(app)
    suffix = uuid.uuid4().hex[:6]
    code = _seed_code(suffix)
    rid = _create_report(c, ADMIN, "personal-2", "SEC " + suffix)
    try:
        _set_content(rid, {"b1": {"text": "리스크가 높다"}, "b2": {"text": "배경 설명"}})

        # 미권한(user3) → 403.
        r3 = c.post(f"/api/reports/{rid}/llm-sections", headers=_h(USER, "dx"), json={})
        assert r3.status_code == 403, r3.text

        async def fake_chat(messages, **kw):
            return types.SimpleNamespace(
                content=f'{{"1": "{code}", "2": "{code}"}}', model="mock", backend="mock"
            )

        monkeypatch.setattr("app.ai.llm.chat_cancellable", fake_chat)
        r = c.post(
            f"/api/reports/{rid}/llm-sections",
            headers=_h(ADMIN, "personal-2"),
            json={"overwrite": True},
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["assigned"] == 2
        bs = _block_sections(rid)
        assert bs.get("b1") == code and bs.get("b2") == code
    finally:
        _cleanup(rid, suffix)


def test_llm_sections_fill_empty_only(monkeypatch):
    """overwrite=False 면 이미 지정된 위젯은 건드리지 않고 빈 것만 채운다."""
    c = TestClient(app)
    suffix = uuid.uuid4().hex[:6]
    code = _seed_code(suffix)
    rid = _create_report(c, ADMIN, "personal-2", "FILL " + suffix)
    try:
        # b1 은 이미 수동 지정("keep"), b2 는 빈 상태.
        _set_content(
            rid,
            {"b1": {"text": "리스크가 높다"}, "b2": {"text": "배경 설명"}},
            block_sections={"b1": "keep_manual"},
        )

        # 빈 것(b2)만 목록에 오르므로 LLM 은 번호 1 = b2 를 받는다.
        async def fake_chat(messages, **kw):
            return types.SimpleNamespace(
                content=f'{{"1": "{code}"}}', model="mock", backend="mock"
            )

        monkeypatch.setattr("app.ai.llm.chat_cancellable", fake_chat)
        r = c.post(
            f"/api/reports/{rid}/llm-sections",
            headers=_h(ADMIN, "personal-2"),
            json={"overwrite": False},
        )
        assert r.status_code == 200, r.text
        bs = _block_sections(rid)
        assert bs.get("b1") == "keep_manual"  # 기존 보존
        assert bs.get("b2") == code           # 빈 것만 채움
    finally:
        _cleanup(rid, suffix)


def test_llm_sections_drops_invalid_code(monkeypatch):
    """분류 목록에 없는 code 는 무시하고 유효한 것만 적용한다."""
    c = TestClient(app)
    suffix = uuid.uuid4().hex[:6]
    code = _seed_code(suffix)
    rid = _create_report(c, ADMIN, "personal-2", "INV " + suffix)
    try:
        _set_content(rid, {"b1": {"text": "리스크"}, "b2": {"text": "배경"}})

        async def fake_chat(messages, **kw):
            # 2번은 없는 코드 → 무시. 1번만 유효.
            return types.SimpleNamespace(
                content=f'{{"1": "{code}", "2": "no_such_code"}}',
                model="mock",
                backend="mock",
            )

        monkeypatch.setattr("app.ai.llm.chat_cancellable", fake_chat)
        r = c.post(
            f"/api/reports/{rid}/llm-sections",
            headers=_h(ADMIN, "personal-2"),
            json={"overwrite": True},
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["assigned"] == 1
        bs = _block_sections(rid)
        assert bs.get("b1") == code
        assert "b2" not in bs  # 없는 코드는 반영 안 됨
    finally:
        _cleanup(rid, suffix)
