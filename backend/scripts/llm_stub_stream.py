"""개발용 스트리밍 LLM 스텁 — OpenAI 호환 /v1/chat/completions.

대화형 검색의 '답변 스트리밍(타이핑)'을 **dev 브라우저에서 실제로 보기 위한** 것.
mock 백엔드는 즉시 반환이라 타이핑이 안 보이므로, 이 스텁이 토큰을 지연 두고 SSE 로
뱉는다. 실제 GLM 대신 붙이는 최소 서버.

실행:
    cd backend && source venv/bin/activate
    python scripts/llm_stub_stream.py                 # 기본 :8900, 40ms/글자
    STUB_PORT=8900 STUB_DELAY_MS=60 python scripts/llm_stub_stream.py
    STUB_NO_TOOLS=1 python scripts/llm_stub_stream.py  # 도구 조사 생략(순수 스트리밍만)

그다음 backend/.env 에:
    LLM_BACKEND=openai
    LLM_BASE_URL=http://localhost:8900/v1
    LLM_MODEL=stub
앱(run.py) 재시작 → 사이드바 "대화" 에서 질문 → 진행 상황 + 타이핑 확인.
(끝나면 .env 를 원래대로 되돌리거나 LLM_BACKEND=mock 로.)

동작:
  - stream=false + tools 있고 아직 도구 안 씀 → search_reports 도구 1회 유도
    (에이전트가 실제 dev 보고서를 검색 → 진행 상황·인용 확인). STUB_NO_TOOLS=1 이면 생략.
  - stream=false + 도구 이미 씀(or tools 없음) → 짧은 답(도구 루프 종료).
  - stream=true → 답변을 글자 단위로 지연 스트리밍(Phase 2 답변).
"""
import asyncio
import json
import os

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI()

DELAY = float(os.getenv("STUB_DELAY_MS", "40")) / 1000.0
NO_TOOLS = os.getenv("STUB_NO_TOOLS", "") not in ("", "0", "false", "False")


def _last_user(messages: list) -> str:
    for m in reversed(messages):
        if m.get("role") == "user":
            return m.get("content") or ""
    return ""


def _answer_text(messages: list) -> str:
    q = _last_user(messages)
    return (
        f"질문 “{q}” 에 대한 스트리밍 스텁 답변입니다. "
        "이 문장이 한 글자씩 흘러나오면 답변 스트리밍이 정상 동작하는 것입니다. "
        "실제 운영에서는 GLM 이 아카이브 근거로 답합니다."
    )


@app.get("/v1/models")
def models():
    return {"data": [{"id": "stub", "object": "model"}]}


@app.post("/v1/chat/completions")
async def chat(req: Request):
    body = await req.json()
    messages = body.get("messages") or []
    tools = body.get("tools")
    stream = bool(body.get("stream"))
    model = body.get("model") or "stub"
    used_tool = any(m.get("role") == "tool" for m in messages)

    if not stream:
        # Phase 1(도구 조사). 아직 도구 안 썼고 tools 제공됐으면 search_reports 유도.
        if tools and not used_tool and not NO_TOOLS:
            tool_call = {
                "id": "call_stub_1",
                "type": "function",
                "function": {
                    "name": "search_reports",
                    "arguments": json.dumps(
                        {"query": _last_user(messages)}, ensure_ascii=False
                    ),
                },
            }
            return JSONResponse({
                "model": model,
                "choices": [{
                    "index": 0,
                    "finish_reason": "tool_calls",
                    "message": {"role": "assistant", "content": None,
                                "tool_calls": [tool_call]},
                }],
            })
        # 도구 종료 → 짧은 답(비스트림). Phase 2 가 별도 stream 요청으로 답을 만든다.
        return JSONResponse({
            "model": model,
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": _answer_text(messages)},
            }],
        })

    # stream=true → 글자 단위 지연 스트리밍(Phase 2 최종 답변).
    async def gen():
        for tok in _answer_text(messages):
            chunk = {"model": model, "choices": [{"index": 0, "delta": {"content": tok}}]}
            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
            await asyncio.sleep(DELAY)
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


if __name__ == "__main__":
    port = int(os.getenv("STUB_PORT", "8900"))
    print(
        f"[llm-stub-stream] http://localhost:{port}/v1  "
        f"(delay {DELAY * 1000:.0f}ms/글자, tools={'off' if NO_TOOLS else 'on'})"
    )
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
