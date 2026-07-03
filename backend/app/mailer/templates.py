"""메일 템플릿 — 외부 의존 없이 string.Template 로 렌더.

render(name, context) -> (subject, html, text). 각 템플릿은 subject/text 본문을
정의하고, 공통 HTML 레이아웃(_LAYOUT)으로 감싼다. context 값은 HTML 이스케이프.
"""
from __future__ import annotations

import html as _html
from string import Template
from typing import Optional

from app.config import settings

# 공통 HTML 레이아웃. $title/$body_html/$app_name 치환.
_LAYOUT = Template(
    """<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f5f7;">
  <div style="max-width:560px;margin:24px auto;padding:32px;background:#ffffff;
              border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,
              'Segoe UI',Roboto,'Malgun Gothic',sans-serif;color:#1f2933;
              line-height:1.6;">
    <div style="font-size:18px;font-weight:700;margin-bottom:16px;">$title</div>
    <div style="font-size:14px;">$body_html</div>
    <hr style="border:none;border-top:1px solid #e4e7eb;margin:28px 0 12px;">
    <div style="font-size:12px;color:#9aa5b1;">$app_name · 자동 발송 메일입니다.</div>
  </div>
</body></html>"""
)


def _button(url: str, label: str) -> str:
    return (
        f'<a href="{_html.escape(url)}" style="display:inline-block;'
        "padding:10px 20px;background:#2563eb;color:#ffffff;text-decoration:none;"
        f'border-radius:8px;font-weight:600;">{_html.escape(label)}</a>'
    )


def _p(text: str) -> str:
    return f'<p style="margin:0 0 14px;">{_html.escape(text)}</p>'


def _wrap(title: str, body_html: str) -> str:
    return _LAYOUT.substitute(
        title=_html.escape(title),
        body_html=body_html,
        app_name=_html.escape(settings.app_name),
    )


# --- 템플릿 정의 -------------------------------------------------------------
# 각 함수: (context) -> (subject, html, text)


def _tpl_test(ctx: dict):
    subject = f"[{settings.app_name}] 메일 발송 테스트"
    body = (
        _p("메일러 설정이 정상입니다. 이 메일이 보이면 SMTP 발송이 동작합니다.")
        + _p(f"백엔드: {ctx.get('backend', '?')}")
    )
    text = (
        "메일러 설정이 정상입니다. 이 메일이 보이면 SMTP 발송이 동작합니다.\n"
        f"백엔드: {ctx.get('backend', '?')}"
    )
    return subject, _wrap("메일 발송 테스트", body), text


def _tpl_password_reset(ctx: dict):
    url = ctx["url"]
    name = ctx.get("name") or "사용자"
    minutes = ctx.get("expires_minutes", 30)
    subject = f"[{settings.app_name}] 비밀번호 재설정"
    body = (
        _p(f"{name}님, 아래 버튼을 눌러 비밀번호를 재설정하세요.")
        + f'<div style="margin:20px 0;">{_button(url, "비밀번호 재설정")}</div>'
        + _p(f"이 링크는 {minutes}분 후 만료됩니다. 본인이 요청하지 않았다면 무시하세요.")
    )
    text = (
        f"{name}님, 아래 링크에서 비밀번호를 재설정하세요.\n{url}\n\n"
        f"이 링크는 {minutes}분 후 만료됩니다. 본인이 요청하지 않았다면 무시하세요."
    )
    return subject, _wrap("비밀번호 재설정", body), text


def _tpl_notification(ctx: dict):
    """범용 알림 메일. ctx: title, message, url(선택), action_label(선택)."""
    title = ctx.get("title") or f"{settings.app_name} 알림"
    message = ctx.get("message") or ""
    url = ctx.get("url")
    action = ctx.get("action_label") or "열기"
    subject = ctx.get("subject") or f"[{settings.app_name}] {title}"
    body = _p(message)
    text = message
    if url:
        body += f'<div style="margin:20px 0;">{_button(url, action)}</div>'
        text += f"\n\n{action}: {url}"
    return subject, _wrap(title, body), text


_TEMPLATES = {
    "test": _tpl_test,
    "password_reset": _tpl_password_reset,
    "notification": _tpl_notification,
}


def render(name: str, context: Optional[dict] = None):
    """(subject, html, text) 반환. 알 수 없는 템플릿이면 KeyError."""
    try:
        fn = _TEMPLATES[name]
    except KeyError:
        raise KeyError(f"알 수 없는 메일 템플릿: {name!r}")
    return fn(context or {})
