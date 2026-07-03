"""이메일 발송 핸들러 — 모든 나가는 메일이 이 잡을 경유한다.

인라인 발송 대신 큐로 돌려 SMTP 지연이 요청을 막지 않게 하고, 실패 시
큐의 자동 재시도(backoff)·관리자 "작업 큐" 탭 가시성을 얻는다.

payload:
    to: str | list[str]   # 수신자
    subject: str          # 제목
    html: str | None      # HTML 본문
    text: str | None      # 평문 본문(폴백)

예외를 던지면 큐가 재시도한다 → send_now 의 실패를 그대로 올린다.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.jobs.registry import handler
from app.mailer import service as mail_service


@handler("send_email")
def send_email(session: Session, payload: dict) -> dict:
    return mail_service.send_now(
        to=payload["to"],
        subject=payload["subject"],
        html=payload.get("html"),
        text=payload.get("text"),
    )
