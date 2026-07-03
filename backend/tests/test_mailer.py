"""메일러 코어 — 렌더/백엔드 분기/큐 적재+핸들러 왕복.

email_backend=mock 으로 강제해 OUTBOX 를 검사한다(실제 발송 없음).
"""
from __future__ import annotations

import pytest

from app.config import settings
from app.mailer import service, templates
from app.mailer.service import OUTBOX


@pytest.fixture(autouse=True)
def _mock_backend():
    prev = settings.email_backend
    settings.email_backend = "mock"
    OUTBOX.clear()
    try:
        yield
    finally:
        settings.email_backend = prev
        OUTBOX.clear()


def test_render_templates_return_subject_html_text():
    for name, ctx in (
        ("test", {"backend": "mock"}),
        ("password_reset", {"url": "https://x/reset?t=abc", "name": "홍길동"}),
        ("notification", {"title": "새 코멘트", "message": "본문", "url": "https://x/r/1"}),
    ):
        subject, html, text = templates.render(name, ctx)
        assert subject and html and text
        assert "<html" in html.lower()

    with pytest.raises(KeyError):
        templates.render("nope", {})


def test_send_now_mock_captures_outbox():
    res = service.send_now(to="a@samsung.com", subject="제목", text="본문")
    assert res["backend"] == "mock"
    assert len(OUTBOX) == 1
    assert OUTBOX[0]["to"] == ["a@samsung.com"]
    assert OUTBOX[0]["subject"] == "제목"


def test_send_now_empty_recipient_raises():
    with pytest.raises(ValueError):
        service.send_now(to="  ", subject="x", text="y")


def test_password_reset_link_escaped_in_html():
    _, html, _ = templates.render(
        "password_reset", {"url": "https://x/reset?t=a&b=c", "name": "<b>"}
    )
    assert "&amp;b=c" in html  # URL 의 & 가 이스케이프됨
    assert "<b>" not in html  # 이름의 태그가 이스케이프됨


def test_enqueue_and_handler_roundtrip():
    """enqueue_email → send_email 핸들러 실행 → OUTBOX 에 도착."""
    from app.database import SessionLocal
    from app.jobs.handlers import send_email as handler_mod

    db = SessionLocal()
    try:
        job_id = service.enqueue_email(
            db,
            to="b@samsung.com",
            template="test",
            context={"backend": "mock"},
        )
        db.commit()
        assert job_id
        from app.jobs.models import Job

        job = db.get(Job, job_id)
        assert job.type == "send_email"
        # 핸들러 직접 실행(워커 없이) — 발송 결과 확인.
        OUTBOX.clear()
        result = handler_mod.send_email(db, job.payload)
        assert result["backend"] == "mock"
        assert OUTBOX and OUTBOX[0]["to"] == ["b@samsung.com"]
        # 정리
        db.delete(job)
        db.commit()
    finally:
        db.close()
