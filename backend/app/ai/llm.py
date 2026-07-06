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
    LLM_NO_PROXY  = true   (폐쇄망 직결 — httpx 가 HTTP_PROXY env 우회. 기본 true)
"""
from __future__ import annotations

import json as _json
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

import httpx

from app.config import settings


class LLMError(RuntimeError):
    """LLM 생성 실패(백엔드 오류·타임아웃·응답 형식 이상). 호출부(Q&A 라우트)는
    502+안내로, 요약 핸들러는 예외→큐 재시도로 처리한다."""


class LLMContextError(LLMError):
    """요청(prompt + max_tokens)이 모델 컨텍스트 한도를 넘어 서버가 거부함(보통
    400). 같은 입력으로 재시도해도 동일 → 호출부는 사용자에게 '토큰 초과'를 명확히
    알리고 즉시 멈춘다(작성 라우트). 일반 LLMError 와 구분해 메시지를 다르게 준다."""


class LLMCancelled(LLMError):
    """스트리밍 생성 중 호출자가 취소를 요청해 중단됨(보통 클라이언트 연결 끊김).
    `chat_cancellable` 이 `should_cancel()` 이 True 면 던진다 — 이때 업스트림
    HTTP 연결을 닫으므로 Ollama/llama-server 도 생성을 멈춘다(GPU 해제). 호출부는
    이를 정상 취소로 처리(에러 토스트 X)한다."""


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
    # 'stop'|'length'|... — 'length' 면 토큰 한도에서 잘림(미완 JSON 원인). 없으면 None.
    finish_reason: Optional[str] = None
    # function-calling 응답의 도구 호출 목록: [{id, name, arguments(파싱된 dict)}].
    # 도구를 안 쓰거나 백엔드 미지원이면 None. 에이전트 루프(agent.py)가 소비한다.
    tool_calls: Optional[list] = None


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
    json_mode: bool = False,
) -> ChatResult:
    base = settings.llm_base_url.rstrip("/")
    options: dict = {"num_predict": max_tokens}
    if temperature is not None:
        options["temperature"] = temperature
    body: dict = {
        "model": model, "messages": messages, "stream": False, "options": options,
    }
    if json_mode:
        body["format"] = "json"  # ollama 구조화 출력 — 유효 JSON 강제
    try:
        resp = httpx.post(
            f"{base}/api/chat",
            json=body,
            timeout=timeout,
            trust_env=not settings.llm_no_proxy,
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
        finish_reason=data.get("done_reason"),
    )


def _extract_usage_ollama(data: dict) -> Optional[dict]:
    p = data.get("prompt_eval_count")
    c = data.get("eval_count")
    if p is None and c is None:
        return None
    return {"prompt_tokens": p, "completion_tokens": c}


# --- openai 호환 백엔드 (B300/vLLM/sglang) ----------------------------------
# 400 본문이 '컨텍스트/토큰 초과'를 가리키는 신호들(서버마다 문구가 달라 넓게 잡음).
_CONTEXT_OVERFLOW_HINTS = (
    "context length",
    "context window",
    "maximum context",
    "context_length_exceeded",
    "max_tokens",
    "max_model_len",
    "too many tokens",
    "exceeds",
    "reduce the length",
    "토큰",
)


def _is_context_overflow(detail: str) -> bool:
    low = (detail or "").lower()
    return any(h in low for h in _CONTEXT_OVERFLOW_HINTS)


def _chat_openai(
    messages: list[Message],
    *,
    model: str,
    temperature: Optional[float],
    max_tokens: int,
    reasoning_effort: Optional[str],
    timeout: float,
    json_mode: bool = False,
    tools: Optional[list] = None,
    tool_choice: str = "auto",
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
    if tools:
        # function-calling — GLM/Qwen 등 지원 모델. tool 결과 메시지(role:"tool")도
        # messages 에 그대로 실려 온다(에이전트 루프가 조립).
        body["tools"] = tools
        body["tool_choice"] = tool_choice
    if json_mode:
        body["response_format"] = {"type": "json_object"}  # 유효 JSON 강제(vLLM/sglang)
    # GLM reasoning 모델 — 서버 chat_template 에 reasoning_effort 전달.
    if reasoning_effort:
        body["chat_template_kwargs"] = {"reasoning_effort": reasoning_effort}

    headers = {"Content-Type": "application/json"}
    if settings.llm_api_key:
        headers["Authorization"] = f"Bearer {settings.llm_api_key}"

    def _post(b: dict) -> httpx.Response:
        resp = httpx.post(
            f"{base}/chat/completions", json=b, headers=headers, timeout=timeout,
            trust_env=not settings.llm_no_proxy,
        )
        resp.raise_for_status()
        return resp

    try:
        resp = _post(body)
    except httpx.HTTPStatusError as exc:
        status_code = exc.response.status_code if exc.response is not None else None
        detail = ""
        if exc.response is not None:
            try:
                detail = exc.response.text or ""
            except Exception:  # noqa: BLE001 — 본문 못 읽어도 진행
                detail = ""
        # 컨텍스트(토큰) 초과는 같은 입력으로 재시도해도 동일 → 별도 예외로 올려
        # 호출부가 사용자에게 '토큰 초과'를 명확히 알리게 한다.
        if status_code == 400 and _is_context_overflow(detail):
            raise LLMContextError(
                "요청(프롬프트+생성)이 모델 토큰 한도를 초과했습니다: "
                f"{detail[:300]}"
            ) from exc
        # response_format 를 지원 안 하는 서버도 400 을 낸다 — 그 옵션만 빼고 1회
        # 재시도(관대 파서가 형식을 보정). 다른 4xx/5xx 는 그대로 실패.
        if status_code == 400 and json_mode:
            body.pop("response_format", None)
            try:
                resp = _post(body)
            except httpx.HTTPError as exc2:
                raise LLMError(f"openai 호환 호출 실패: {exc2}") from exc2
        else:
            raise LLMError(f"openai 호환 호출 실패: {exc}") from exc
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
    tool_calls = _parse_tool_calls(msg.get("tool_calls"))
    # 도구 호출만 있고 content 가 비는 건 정상(function-calling 턴) — 이 경우 통과.
    if not content and not reasoning and not tool_calls:
        raise LLMError("openai 호환 응답에 content/reasoning/tool_calls 가 모두 없음")
    return ChatResult(
        content=content,
        reasoning=reasoning,
        model=data.get("model") or fallback_model,
        usage=data.get("usage"),
        backend="openai",
        raw=data,
        finish_reason=(choices[0] or {}).get("finish_reason"),
        tool_calls=tool_calls,
    )


def _parse_tool_calls(raw) -> Optional[list]:
    """OpenAI 호환 message.tool_calls → [{id, name, arguments(dict)}].

    arguments 는 JSON 문자열로 오므로 관대하게 파싱(깨지면 {} 로). 도구 호출이
    없으면 None."""
    if not raw or not isinstance(raw, list):
        return None
    out = []
    for tc in raw:
        fn = (tc or {}).get("function") or {}
        args_raw = fn.get("arguments")
        if isinstance(args_raw, dict):
            args = args_raw
        else:
            try:
                args = _json.loads(args_raw) if args_raw else {}
            except (ValueError, TypeError):
                args = {}
        out.append({"id": tc.get("id"), "name": fn.get("name"), "arguments": args})
    return out or None


# --- 스트리밍(취소 가능) 백엔드 --------------------------------------------
# 동기 chat() 은 httpx.post(stream=False) 라 한 번 들어가면 못 끊는다. 사용자가
# 긴 생성을 중단할 수 있도록, stream=True 로 청크를 받으며 매 청크마다
# should_cancel() 을 확인하는 비동기 버전을 둔다. 취소 시 with 블록을 빠져나가며
# 업스트림 연결을 닫아 LLM 생성도 멈춘다. 누적 결과는 동기 chat() 과 같은
# ChatResult 로 돌려준다(호출부는 .content 만 쓰면 그대로 동작).

# 호출자가 "지금 취소?"를 알려주는 콜백(보통 starlette Request.is_disconnected).
CancelCheck = Callable[[], Awaitable[bool]]


class _OpenAIHTTPError(Exception):
    """openai 호환 스트림 응답이 4xx/5xx — json_mode 폴백 판단용 내부 신호."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(f"HTTP {status_code}")
        self.status_code = status_code
        self.detail = detail


async def _maybe_cancel(should_cancel: Optional[CancelCheck]) -> None:
    if should_cancel is not None and await should_cancel():
        raise LLMCancelled("생성이 사용자 요청으로 취소되었습니다.")


async def _chat_ollama_stream(
    messages: list[Message],
    *,
    model: str,
    temperature: Optional[float],
    max_tokens: int,
    timeout: float,
    json_mode: bool,
    should_cancel: Optional[CancelCheck],
) -> ChatResult:
    base = settings.llm_base_url.rstrip("/")
    options: dict = {"num_predict": max_tokens}
    if temperature is not None:
        options["temperature"] = temperature
    body: dict = {
        "model": model, "messages": messages, "stream": True, "options": options,
    }
    if json_mode:
        body["format"] = "json"
    parts: list[str] = []
    model_name, finish_reason, usage = model, None, None
    try:
        async with httpx.AsyncClient(
            timeout=timeout, trust_env=not settings.llm_no_proxy
        ) as client:
            async with client.stream("POST", f"{base}/api/chat", json=body) as resp:
                if resp.status_code >= 400:
                    detail = (await resp.aread()).decode(errors="replace")
                    raise LLMError(
                        f"ollama 호출 실패: HTTP {resp.status_code} {detail[:300]}"
                    )
                async for line in resp.aiter_lines():
                    await _maybe_cancel(should_cancel)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        evt = _json.loads(line)
                    except ValueError:
                        continue
                    tok = (evt.get("message") or {}).get("content") or ""
                    if tok:
                        parts.append(tok)
                    if evt.get("model"):
                        model_name = evt["model"]
                    if evt.get("done"):
                        finish_reason = evt.get("done_reason")
                        usage = _extract_usage_ollama(evt)
    except LLMCancelled:
        raise
    except httpx.HTTPError as exc:
        raise LLMError(f"ollama 호출 실패: {exc}") from exc

    content = "".join(parts).strip()
    if not content:
        raise LLMError("ollama 응답에 message.content 가 없음")
    return ChatResult(
        content=content, reasoning=None, model=model_name, usage=usage,
        backend="ollama", raw={"streamed": True}, finish_reason=finish_reason,
    )


async def _chat_openai_stream(
    messages: list[Message],
    *,
    model: str,
    temperature: Optional[float],
    max_tokens: int,
    reasoning_effort: Optional[str],
    timeout: float,
    json_mode: bool,
    should_cancel: Optional[CancelCheck],
) -> ChatResult:
    base = settings.llm_base_url.rstrip("/")
    headers = {"Content-Type": "application/json"}
    if settings.llm_api_key:
        headers["Authorization"] = f"Bearer {settings.llm_api_key}"

    def _build(json_on: bool) -> dict:
        b: dict = {
            "model": model, "messages": messages,
            "max_tokens": max_tokens, "stream": True,
        }
        if temperature is not None:
            b["temperature"] = temperature
        if json_on:
            b["response_format"] = {"type": "json_object"}
        if reasoning_effort:
            b["chat_template_kwargs"] = {"reasoning_effort": reasoning_effort}
        return b

    async def _run(json_on: bool) -> ChatResult:
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        model_name, finish_reason = model, None
        async with httpx.AsyncClient(
            timeout=timeout, trust_env=not settings.llm_no_proxy
        ) as client:
            async with client.stream(
                "POST", f"{base}/chat/completions",
                json=_build(json_on), headers=headers,
            ) as resp:
                if resp.status_code >= 400:
                    detail = (await resp.aread()).decode(errors="replace")
                    if resp.status_code == 400 and _is_context_overflow(detail):
                        raise LLMContextError(
                            "요청(프롬프트+생성)이 모델 토큰 한도를 초과했습니다: "
                            f"{detail[:300]}"
                        )
                    raise _OpenAIHTTPError(resp.status_code, detail)
                async for line in resp.aiter_lines():
                    await _maybe_cancel(should_cancel)
                    line = line.strip()
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[len("data:"):].strip()
                    if data == "[DONE]":
                        break
                    try:
                        evt = _json.loads(data)
                    except ValueError:
                        continue
                    if evt.get("model"):
                        model_name = evt["model"]
                    choices = evt.get("choices") or []
                    if not choices:
                        continue
                    ch0 = choices[0] or {}
                    delta = ch0.get("delta") or {}
                    if delta.get("content"):
                        content_parts.append(delta["content"])
                    rc = delta.get("reasoning_content") or delta.get("reasoning")
                    if isinstance(rc, str) and rc:
                        reasoning_parts.append(rc)
                    if ch0.get("finish_reason"):
                        finish_reason = ch0["finish_reason"]
        content = "".join(content_parts).strip()
        reasoning = "".join(reasoning_parts).strip() or None
        if not content and not reasoning:
            raise LLMError("openai 호환 응답에 content/reasoning 둘 다 없음")
        return ChatResult(
            content=content, reasoning=reasoning, model=model_name, usage=None,
            backend="openai", raw={"streamed": True}, finish_reason=finish_reason,
        )

    try:
        return await _run(json_mode)
    except _OpenAIHTTPError as exc:
        # response_format 미지원 서버는 400 → 그 옵션만 빼고 1회 재시도(동기판과 동일).
        if exc.status_code == 400 and json_mode:
            try:
                return await _run(False)
            except _OpenAIHTTPError as exc2:
                raise LLMError(
                    f"openai 호환 호출 실패: HTTP {exc2.status_code} "
                    f"{exc2.detail[:200]}"
                ) from exc2
        raise LLMError(
            f"openai 호환 호출 실패: HTTP {exc.status_code} {exc.detail[:200]}"
        ) from exc
    except LLMCancelled:
        raise
    except httpx.HTTPError as exc:
        raise LLMError(f"openai 호환 호출 실패: {exc}") from exc


async def chat_cancellable(
    messages: list[Message],
    *,
    model: Optional[str] = None,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    reasoning_effort: Optional[str] = None,
    timeout: Optional[float] = None,
    json_mode: bool = False,
    should_cancel: Optional[CancelCheck] = None,
) -> ChatResult:
    """chat() 의 비동기·취소 가능 버전. 스트리밍으로 청크를 누적하되 매 청크마다
    should_cancel() 을 확인해 True 면 LLMCancelled 를 던지고 업스트림 연결을
    닫는다(LLM 생성도 중단). 반환은 동기 chat() 과 동일한 ChatResult.

    should_cancel: 비동기 콜백(True 면 취소). 보통 라우트의
        request.is_disconnected 를 넘긴다 — 프론트가 요청을 abort 하면 연결이
        끊겨 여기서 취소된다.
    """
    backend = (settings.llm_backend or "mock").lower()
    model = model or settings.llm_model
    max_tokens = max_tokens or settings.llm_max_tokens
    timeout = timeout or settings.llm_timeout_s
    effort = reasoning_effort if reasoning_effort is not None else (
        settings.llm_reasoning_effort or None
    )

    if backend == "mock":
        await _maybe_cancel(should_cancel)
        return _chat_mock(messages, model=model)
    if backend == "ollama":
        return await _chat_ollama_stream(
            messages, model=model, temperature=temperature, max_tokens=max_tokens,
            timeout=timeout, json_mode=json_mode, should_cancel=should_cancel,
        )
    if backend == "openai":
        return await _chat_openai_stream(
            messages, model=model, temperature=temperature, max_tokens=max_tokens,
            reasoning_effort=effort, timeout=timeout, json_mode=json_mode,
            should_cancel=should_cancel,
        )
    raise LLMError(f"알 수 없는 LLM_BACKEND: {backend!r} (openai|ollama|mock)")


# --- 공개 API ---------------------------------------------------------------
def chat(
    messages: list[Message],
    *,
    model: Optional[str] = None,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    reasoning_effort: Optional[str] = None,
    timeout: Optional[float] = None,
    json_mode: bool = False,
    tools: Optional[list] = None,
    tool_choice: str = "auto",
) -> ChatResult:
    """채팅 메시지 → ChatResult. 백엔드는 settings.llm_backend 로 결정.

    messages: [{"role": "system"|"user"|"assistant", "content": str}, ...]
    reasoning_effort: 미지정 시 settings.llm_reasoning_effort 사용(openai 전용).
    json_mode: True 면 서버에 유효 JSON 출력을 강제(openai response_format /
        ollama format). 형식 일탈을 줄이는 가장 확실한 수단. mock 은 무시.
    tools: function-calling 도구 스키마(OpenAI 형식). 지원 백엔드(openai/GLM)만
        사용 — 응답 tool_calls 는 ChatResult.tool_calls 로. mock/ollama 는 무시.
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
            max_tokens=max_tokens, timeout=timeout, json_mode=json_mode,
        )
    if backend == "openai":
        return _chat_openai(
            messages, model=model, temperature=temperature, max_tokens=max_tokens,
            reasoning_effort=effort, timeout=timeout, json_mode=json_mode,
            tools=tools, tool_choice=tool_choice,
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
            resp = httpx.get(
                f"{base}/models", headers=headers, timeout=timeout,
                trust_env=not settings.llm_no_proxy,
            )
            resp.raise_for_status()
            return [m.get("id") for m in resp.json().get("data", []) if m.get("id")]
        if backend == "ollama":
            resp = httpx.get(
                f"{base}/api/tags", timeout=timeout,
                trust_env=not settings.llm_no_proxy,
            )
            resp.raise_for_status()
            return [m.get("name") for m in resp.json().get("models", []) if m.get("name")]
    except httpx.HTTPError as exc:
        raise LLMError(f"모델 목록 조회 실패: {exc}") from exc
    return []
