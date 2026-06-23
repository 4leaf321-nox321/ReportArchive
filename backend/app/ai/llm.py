"""생성 LLM 클라이언트 — 백엔드 추상화 (mock | ollama | openai).

`embeddings.py` 와 대칭. `chat(messages) -> ChatResult` 한 함수로 통일한다.
운영(B300)은 OpenAI 호환 서버(`/v1/chat/completions`, 모델 GLM-5-2)를 호출하고,
개발/테스트는 mock(네트워크 없이 결정적 응답)으로 전 파이프라인을 검증한다.
`.env` 한 줄(LLM_BACKEND)로 전환 — 기본 mock 이라 운영 무영향.

설계: B300_보조AI_설계.md §L0. dev 서버는 B300 에 못 닿으므로(운영서버만 닿음)
openai 경로는 로컬 스텁(scripts/llm_stub.py)으로 검증한다.

응답 파싱은 **관대**하게: `content` + (있으면)`reasoning_content`/`reasoning` 를 분리·
스트립하고, `usage` 유무에 무관하게 동작한다. GLM-5.2 같은 reasoning 모델이 사고
과정을 별 필드로 돌려줘도 본문(content)만 깔끔히 뽑는다.

env(.env):
    LLM_BACKEND   = openai | ollama | mock     (기본 mock)
    LLM_BASE_URL  = http://<b300-host>:10000/v1   (openai — /v1 포함)
                    http://localhost:11434         (ollama — 서버 루트)
    LLM_MODEL     = GLM-5-2 등
    LLM_API_KEY   = (OpenAI 호환 서버 인증 시)
    LLM_TIMEOUT_S = 120
    LLM_MAX_TOKENS= 1024
    LLM_REASONING_EFFORT = low|medium|high   (빈 값=전달 안 함)
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import httpx

from app.config import settings


class LLMError(RuntimeError):
    """LLM 생성 실패(백엔드 오류·타임아웃·응답 형식 이상). 호출부(Q&A 라우트)는
    502+안내로, 요약 핸들러는 예외→큐 재시도로 처리한다."""


@dataclass
class ChatResult:
    """생성 1회 결과. 기능 코드는 보통 `.content` 만 쓴다. 진단 탭은 reasoning/
    usage/raw 까지 펼쳐 보여준다."""

    content: str
    reasoning: Optional[str]
    model: Optional[str]
    usage: Optional[dict]
    backend: str
    raw: dict


Message = dict  # {"role": "user"|"system"|"assistant", "content": str}


# --- mock 백엔드 ------------------------------------------------------------
def _chat_mock(messages: list[Message], *, model: str) -> ChatResult:
    """네트워크 없이 결정적 응답. 마지막 user 메시지를 되울려 준다(플러밍 검증용).

    의미 있는 답을 생성하지 않는다 — 프롬프트 조립·인용 파싱·게이트·잡 흐름 등
    *주변 코드*를 테스트하기 위한 것. 같은 입력 → 같은 출력."""
    last_user = next(
        (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"),
        "",
    )
    content = f"[mock:{model}] {last_user}".strip()
    return ChatResult(
        content=content,
        reasoning=None,
        model=model,
        usage=None,
        backend="mock",
        raw={"mock": True, "echo": last_user},
    )


# --- ollama 백엔드 ----------------------------------------------------------
def _chat_ollama(
    messages: list[Message],
    *,
    model: str,
    temperature: Optional[float],
    max_tokens: int,
    timeout: float,
) -> ChatResult:
    base = settings.llm_base_url.rstrip("/")
    options: dict = {"num_predict": max_tokens}
    if temperature is not None:
        options["temperature"] = temperature
    try:
        resp = httpx.post(
            f"{base}/api/chat",
            json={"model": model, "messages": messages, "stream": False, "options": options},
            timeout=timeout,
        )
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise LLMError(f"ollama 호출 실패: {exc}") from exc

    data = resp.json()
    msg = data.get("message") or {}
    content = (msg.get("content") or "").strip()
    if not content:
        raise LLMError("ollama 응답에 message.content 가 없음")
    usage = _extract_usage_ollama(data)
    return ChatResult(
        content=content,
        reasoning=None,  # ollama chat 은 보통 reasoning 분리 필드 없음
        model=data.get("model") or model,
        usage=usage,
        backend="ollama",
        raw=data,
    )


def _extract_usage_ollama(data: dict) -> Optional[dict]:
    p = data.get("prompt_eval_count")
    c = data.get("eval_count")
    if p is None and c is None:
        return None
    return {"prompt_tokens": p, "completion_tokens": c}


# --- openai 호환 백엔드 (B300/vLLM/sglang) ----------------------------------
def _chat_openai(
    messages: list[Message],
    *,
    model: str,
    temperature: Optional[float],
    max_tokens: int,
    reasoning_effort: Optional[str],
    timeout: float,
) -> ChatResult:
    """OpenAI 호환 `/v1/chat/completions`. base_url 은 /v1 까지 포함한다고 가정."""
    base = settings.llm_base_url.rstrip("/")
    body: dict = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
    }
    if temperature is not None:
        body["temperature"] = temperature
    # GLM reasoning 모델 — 서버 chat_template 에 reasoning_effort 전달.
    if reasoning_effort:
        body["chat_template_kwargs"] = {"reasoning_effort": reasoning_effort}

    headers = {"Content-Type": "application/json"}
    if settings.llm_api_key:
        headers["Authorization"] = f"Bearer {settings.llm_api_key}"

    try:
        resp = httpx.post(
            f"{base}/chat/completions", json=body, headers=headers, timeout=timeout
        )
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise LLMError(f"openai 호환 호출 실패: {exc}") from exc

    data = resp.json()
    return _parse_openai_response(data, fallback_model=model)


def _parse_openai_response(data: dict, *, fallback_model: str) -> ChatResult:
    """OpenAI 호환 응답을 관대하게 파싱. choices[0].message.content 가 본문,
    reasoning_content/reasoning 가 있으면 분리한다."""
    choices = data.get("choices")
    if not choices:
        raise LLMError(f"openai 호환 응답에 choices 가 없음: {str(data)[:200]}")
    msg = (choices[0] or {}).get("message") or {}
    content = (msg.get("content") or "").strip()
    reasoning = msg.get("reasoning_content") or msg.get("reasoning")
    if isinstance(reasoning, str):
        reasoning = reasoning.strip() or None
    if not content and not reasoning:
        raise LLMError("openai 호환 응답에 content/reasoning 둘 다 없음")
    return ChatResult(
        content=content,
        reasoning=reasoning,
        model=data.get("model") or fallback_model,
        usage=data.get("usage"),
        backend="openai",
        raw=data,
    )


# --- 공개 API ---------------------------------------------------------------
def chat(
    messages: list[Message],
    *,
    model: Optional[str] = None,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    reasoning_effort: Optional[str] = None,
    timeout: Optional[float] = None,
) -> ChatResult:
    """채팅 메시지 → ChatResult. 백엔드는 settings.llm_backend 로 결정.

    messages: [{"role": "system"|"user"|"assistant", "content": str}, ...]
    reasoning_effort: 미지정 시 settings.llm_reasoning_effort 사용(openai 전용).
    """
    backend = (settings.llm_backend or "mock").lower()
    model = model or settings.llm_model
    max_tokens = max_tokens or settings.llm_max_tokens
    timeout = timeout or settings.llm_timeout_s
    effort = reasoning_effort if reasoning_effort is not None else (
        settings.llm_reasoning_effort or None
    )

    if backend == "mock":
        return _chat_mock(messages, model=model)
    if backend == "ollama":
        return _chat_ollama(
            messages, model=model, temperature=temperature,
            max_tokens=max_tokens, timeout=timeout,
        )
    if backend == "openai":
        return _chat_openai(
            messages, model=model, temperature=temperature, max_tokens=max_tokens,
            reasoning_effort=effort, timeout=timeout,
        )
    raise LLMError(f"알 수 없는 LLM_BACKEND: {backend!r} (openai|ollama|mock)")


def list_models(*, timeout: Optional[float] = None) -> list[str]:
    """서버가 서빙 중인 모델 id 목록. 진단(연결 테스트)용. mock 은 설정 모델만 반환.

    실패해도 진단이 죽지 않도록 LLMError 를 던지되, 호출부가 잡아 부분 표시한다."""
    backend = (settings.llm_backend or "mock").lower()
    timeout = timeout or min(settings.llm_timeout_s, 15.0)
    if backend == "mock":
        return [settings.llm_model]
    base = settings.llm_base_url.rstrip("/")
    try:
        if backend == "openai":
            headers = {}
            if settings.llm_api_key:
                headers["Authorization"] = f"Bearer {settings.llm_api_key}"
            resp = httpx.get(f"{base}/models", headers=headers, timeout=timeout)
            resp.raise_for_status()
            return [m.get("id") for m in resp.json().get("data", []) if m.get("id")]
        if backend == "ollama":
            resp = httpx.get(f"{base}/api/tags", timeout=timeout)
            resp.raise_for_status()
            return [m.get("name") for m in resp.json().get("models", []) if m.get("name")]
    except httpx.HTTPError as exc:
        raise LLMError(f"모델 목록 조회 실패: {exc}") from exc
    return []
