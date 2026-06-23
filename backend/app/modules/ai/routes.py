"""AI 연결 진단 — B300(생성 LLM) 연결 상태를 *서버 경유*로 확인한다.

dev 서버는 B300 에 못 닿고 운영서버만 닿으므로, 브라우저가 아니라 **서버가** LLM 을
호출해야 한다(B300_보조AI_설계.md §T). 이 엔드포인트가 그 서버 경유 호출이며,
같은 코드가 dev(mock/스텁) 검증 · 운영 실연결 스모크 · 상시 헬스체크를 겸한다.

**접근: 일단 시스템 관리자 전용**(require_system_admin). 추후 확대 여지는 두되 지금은 관리자만.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.ai.llm import LLMError, chat, list_models
from app.config import settings
from app.modules.users.models import User
from app.shared.auth import require_system_admin
from app.shared.responses import error_response, success_response

router = APIRouter()


class DiagChatPayload(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=8000)
    # 미지정 시 settings.llm_reasoning_effort. "" 면 명시적으로 끔(전달 안 함).
    reasoning_effort: str | None = Field(default=None)


def _config_view() -> dict:
    """현재 LLM 설정 요약(비밀 제외). 진단 탭 상태 카드용."""
    return {
        "backend": settings.llm_backend,
        "base_url": settings.llm_base_url,
        "model": settings.llm_model,
        "has_api_key": bool(settings.llm_api_key),
        "reasoning_effort": settings.llm_reasoning_effort or None,
        "timeout_s": settings.llm_timeout_s,
        "max_tokens": settings.llm_max_tokens,
    }


@router.get("/diag/config")
def diag_config(_: User = Depends(require_system_admin)):
    """설정만 반환(호출 없음). 화면이 백엔드/모델/주소를 먼저 보여줄 때."""
    return success_response(data=_config_view())


@router.post("/diag/ping")
def diag_ping(_: User = Depends(require_system_admin)):
    """짧은 chat 1회 + (가능하면) 모델 목록으로 연결 확인. 실패 시 502+사유."""
    cfg = _config_view()
    # 모델 목록은 부가 정보 — 실패해도 ping 자체는 chat 으로 판정.
    try:
        cfg["models"] = list_models()
    except LLMError:
        cfg["models"] = None

    t0 = time.perf_counter()
    try:
        res = chat([{"role": "user", "content": "ping"}], max_tokens=8)
    except LLMError as exc:
        return error_response(f"LLM 연결 실패: {exc}", status_code=502)
    latency_ms = int((time.perf_counter() - t0) * 1000)

    return success_response(
        data={
            **cfg,
            "ok": True,
            "latency_ms": latency_ms,
            "model_returned": res.model,
            "has_reasoning": res.reasoning is not None,
            "content_preview": res.content[:200],
        }
    )


@router.post("/diag/chat")
def diag_chat(payload: DiagChatPayload, _: User = Depends(require_system_admin)):
    """임의 프롬프트 → 원응답(content + reasoning + usage + latency). 플레이그라운드."""
    t0 = time.perf_counter()
    try:
        res = chat(
            [{"role": "user", "content": payload.prompt}],
            reasoning_effort=payload.reasoning_effort,
        )
    except LLMError as exc:
        return error_response(f"LLM 호출 실패: {exc}", status_code=502)
    latency_ms = int((time.perf_counter() - t0) * 1000)

    return success_response(
        data={
            "content": res.content,
            "reasoning": res.reasoning,
            "usage": res.usage,
            "model": res.model,
            "backend": res.backend,
            "latency_ms": latency_ms,
        }
    )
