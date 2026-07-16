"""메일 발송 코어 — 백엔드 분기(smtp/console/mock) + 큐 적재 헬퍼.

send_now 는 예외를 던지면 큐가 자동 재시도(backoff)한다 → 여기선 실패를
삼키지 말고 그대로 올린다. enqueue_email 은 템플릿을 렌더해 send_email 잡을
적재한다(커밋은 호출자 트랜잭션).
"""
from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, parseaddr
from typing import Optional, Sequence, Union

from sqlalchemy.orm import Session

from app.config import settings

logger = logging.getLogger("app.mailer")

# mock 백엔드가 채우는 테스트용 발송 기록. 테스트가 clear() 후 검사한다.
OUTBOX: list[dict] = []

Recipients = Union[str, Sequence[str]]


def _normalize_recipients(to: Recipients) -> list[str]:
    if isinstance(to, str):
        items = [to]
    else:
        items = list(to)
    out = []
    for raw in items:
        addr = (raw or "").strip()
        if addr:
            out.append(addr)
    if not out:
        raise ValueError("수신자(to)가 비어 있습니다.")
    return out


def _build_message(
    *, to: list[str], subject: str, html: Optional[str], text: Optional[str]
) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = settings.email_from
    msg["To"] = ", ".join(to)
    msg["Subject"] = subject
    reply_to = settings.email_reply_to.strip()
    if reply_to:
        msg["Reply-To"] = reply_to
    # 항상 평문 본문을 두고(구형 클라이언트 폴백), html 이 있으면 대체본으로 추가.
    body_text = text if text is not None else _html_to_text(html or "")
    msg.set_content(body_text or "")
    if html:
        msg.add_alternative(html, subtype="html")
    return msg


def _html_to_text(html: str) -> str:
    """아주 단순한 html→text 폴백(태그 제거). 템플릿이 text 를 주면 안 쓰인다."""
    import re

    text = re.sub(r"<\s*br\s*/?>", "\n", html, flags=re.IGNORECASE)
    text = re.sub(r"</\s*p\s*>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    return text.strip()


def send_now(
    *,
    to: Recipients,
    subject: str,
    html: Optional[str] = None,
    text: Optional[str] = None,
) -> dict:
    """실제 발송(백엔드 분기). 잡 핸들러가 호출한다. 실패 시 예외 → 큐 재시도."""
    recipients = _normalize_recipients(to)
    backend = (settings.email_backend or "console").strip().lower()

    if backend == "mock":
        OUTBOX.append(
            {"to": recipients, "subject": subject, "html": html, "text": text}
        )
        return {"backend": "mock", "to": recipients}

    if backend == "console":
        logger.info(
            "[email:console] to=%s subject=%r\n%s",
            recipients,
            subject,
            (text or _html_to_text(html or ""))[:2000],
        )
        return {"backend": "console", "to": recipients}

    if backend == "smtp":
        _send_smtp(recipients, subject, html, text)
        return {"backend": "smtp", "to": recipients}

    raise ValueError(f"알 수 없는 email_backend: {backend!r}")


def _send_smtp(
    recipients: list[str], subject: str, html: Optional[str], text: Optional[str]
) -> None:
    host = settings.smtp_host.strip()
    if not host:
        raise RuntimeError(
            "smtp_host 가 설정되지 않았습니다(.env SMTP_HOST). 발송 불가."
        )
    port = int(settings.smtp_port)
    tls = (settings.smtp_tls_mode or "starttls").strip().lower()
    timeout = float(settings.smtp_timeout_s)
    msg = _build_message(to=recipients, subject=subject, html=html, text=text)
    # 봉투 발신자는 From 헤더의 주소 부분만(디스플레이 이름 제거).
    envelope_from = parseaddr(settings.email_from)[1] or settings.email_from

    if tls == "ssl":
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL(host, port, timeout=timeout, context=ctx) as smtp:
            _smtp_login_send(smtp, msg, envelope_from, recipients)
    else:
        with smtplib.SMTP(host, port, timeout=timeout) as smtp:
            smtp.ehlo()
            if tls == "starttls":
                smtp.starttls(context=ssl.create_default_context())
                smtp.ehlo()
            _smtp_login_send(smtp, msg, envelope_from, recipients)


def _smtp_login_send(smtp, msg, envelope_from: str, recipients: list[str]) -> None:
    user = settings.smtp_user.strip()
    password = settings.smtp_password
    if user and password:
        smtp.login(user, password)
    smtp.send_message(msg, from_addr=envelope_from, to_addrs=recipients)


def is_active() -> bool:
    """실제로 수신자에게 메일이 도달하는 상태인가. 비활성이면 호출부가 관리자
    중개 등 폴백을 쓴다.

    smtp 는 호스트가 설정돼야 한다. mock 은 OUTBOX 로 캡처되므로 테스트에서
    도달로 친다. console 은 로그로만 찍히고 아무에게도 가지 않으므로 False —
    여기서 True 를 주면 호출부가 '보냈다'고 믿고 폴백을 건너뛴다.
    """
    backend = (settings.email_backend or "console").strip().lower()
    if backend == "smtp":
        return bool(settings.smtp_host.strip())
    return backend == "mock"


def status() -> dict:
    """관리자 화면용 메일러 설정 상태(비밀은 노출 안 함)."""
    backend = (settings.email_backend or "console").strip().lower()
    configured = backend in ("mock", "console") or bool(settings.smtp_host.strip())
    return {
        "backend": backend,
        "configured": configured,
        "from": settings.email_from,
        "smtp_host": settings.smtp_host or None,
        "smtp_port": settings.smtp_port,
        "tls_mode": settings.smtp_tls_mode,
        "auth": bool(settings.smtp_user.strip()),
        "base_url": settings.email_base_url or None,
    }


def enqueue_email(
    session: Session,
    *,
    to: Recipients,
    subject: Optional[str] = None,
    html: Optional[str] = None,
    text: Optional[str] = None,
    template: Optional[str] = None,
    context: Optional[dict] = None,
    dedup_key: Optional[str] = None,
    max_attempts: int = 5,
    created_by: Optional[int] = None,
) -> Optional[int]:
    """send_email 잡을 적재한다(커밋은 호출자). 템플릿명을 주면 렌더 후 적재.

    dedup_key 로 (send_email, key) pending/running 중복을 막아 폭주/이중발송을
    방지한다 — 이미 있으면 조용히 건너뛴다(None 반환).
    """
    from app.jobs import queue
    from app.mailer import templates as mail_templates

    recipients = _normalize_recipients(to)
    if template:
        subject, html, text = mail_templates.render(template, context or {})
    if not subject:
        raise ValueError("subject 또는 template 이 필요합니다.")

    payload = {"to": recipients, "subject": subject, "html": html, "text": text}
    if not dedup_key:
        return queue.enqueue(
            session, "send_email", payload,
            max_attempts=max_attempts, created_by=created_by,
        )
    # dedup_key 중복(UniqueViolation)은 savepoint 안에서 처리해 호출자 트랜잭션을
    # 오염시키지 않는다 — 이미 큐에 있으면 조용히 건너뛴다.
    from sqlalchemy.exc import IntegrityError

    try:
        with session.begin_nested():
            return queue.enqueue(
                session, "send_email", payload,
                dedup_key=dedup_key, max_attempts=max_attempts,
                created_by=created_by,
            )
    except IntegrityError:
        logger.info("send_email 잡 적재 건너뜀(이미 대기 중): dedup_key=%s", dedup_key)
        return None
