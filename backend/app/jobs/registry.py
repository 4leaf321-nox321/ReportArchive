"""핸들러 레지스트리 — 작업 종류(type) → 처리 함수 매핑.

핸들러 시그니처:
    def handler(session: Session, payload: dict) -> dict | None

반환 dict 는 Job.result 에 저장된다(예: {"file_id": "..."}).
예외를 던지면 큐가 자동으로 재시도/실패 처리한다(queue.mark_failed).
새 작업 종류를 추가하려면 handlers/ 아래에 @handler("이름") 함수를 만들고
handlers/__init__.py 에서 import 되게 하면 끝.
"""
from __future__ import annotations

from typing import Callable, Dict

from sqlalchemy.orm import Session

JobHandler = Callable[[Session, dict], "dict | None"]

JOB_HANDLERS: Dict[str, JobHandler] = {}


def handler(name: str) -> Callable[[JobHandler], JobHandler]:
    """데코레이터 — 작업 종류 이름으로 핸들러 등록."""

    def deco(fn: JobHandler) -> JobHandler:
        if name in JOB_HANDLERS:
            raise RuntimeError(f"duplicate job handler: {name}")
        JOB_HANDLERS[name] = fn
        return fn

    return deco


def get_handler(name: str) -> JobHandler:
    try:
        return JOB_HANDLERS[name]
    except KeyError:
        raise KeyError(f"unknown job type: {name!r}")
