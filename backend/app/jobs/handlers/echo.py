"""self-test 핸들러 — 큐 레일(enqueue→claim→처리→result) 점검용.

도메인 영향 0. payload 를 그대로 result 로 돌려준다. payload 에
{"fail": true} 가 있으면 일부러 예외를 던져 재시도/실패 경로를 확인한다.
Phase ② 에서 실제 export 핸들러가 들어오면 이 모듈은 그대로 둬도(테스트용)
무방하다.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.jobs.registry import handler


@handler("echo")
def echo(session: Session, payload: dict) -> dict:
    if payload.get("fail"):
        raise RuntimeError(payload.get("error", "intentional echo failure"))
    return {"echo": payload}
