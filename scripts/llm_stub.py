"""OpenAI 호환 LLM 스텁 — dev 에서 B300 없이 llm.py 의 openai 경로를 검증한다.

dev 서버는 실제 B300(10.198.143.137:10000)에 못 닿으므로(운영서버만 닿음),
GLM-5.2 와 **같은 응답 모양**으로 흉내내는 작은 서버를 띄워 우리 어댑터(httpx·요청
바디·응답 파싱·타임아웃)를 그대로 실행한다. B300_보조AI_설계.md §T.

엔드포인트:
    GET  /v1/models             — 모델 목록
    POST /v1/chat/completions   — 마지막 user 메시지를 되울림. 요청에
                                  chat_template_kwargs.reasoning_effort 가 있으면
                                  GLM 처럼 message.reasoning_content 를 채워 응답.

운영에서 실제 응답을 1회 캡처해 backend/tests/fixtures/glm_chat_response.json 로
두면, 그 파일을 그대로 재생한다(진짜 응답 모양에 파싱 핀 고정).

실행:
    python scripts/llm_stub.py            # 0.0.0.0:9001
    python scripts/llm_stub.py --port 9100
그리고 backend/.env 에:
    LLM_BACKEND=openai
    LLM_BASE_URL=http://localhost:9001/v1
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

STUB_MODEL = "GLM-5-2"
_FIXTURE = (
    Path(__file__).resolve().parent.parent
    / "backend" / "tests" / "fixtures" / "glm_chat_response.json"
)

app = FastAPI(title="LLM stub (OpenAI-compatible)")


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": STUB_MODEL, "object": "model"}]}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()

    # 운영 캡처 fixture 가 있으면 그대로 재생(진짜 응답 모양 핀 고정).
    if _FIXTURE.exists():
        try:
            return JSONResponse(json.loads(_FIXTURE.read_text(encoding="utf-8")))
        except (ValueError, OSError):
            pass  # 손상 시 합성 응답으로 폴백

    messages = body.get("messages", [])
    last_user = next(
        (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"),
        "",
    )
    effort = (body.get("chat_template_kwargs") or {}).get("reasoning_effort")
    message = {"role": "assistant", "content": f"[stub:{body.get('model', STUB_MODEL)}] {last_user}"}
    # GLM reasoning 모델 흉내 — effort 지정 시 사고 과정을 별 필드로(어댑터의
    # reasoning_content 분리·스트립 검증용).
    if effort:
        message["reasoning_content"] = f"(reasoning_effort={effort}) 생각하는 중…"

    return JSONResponse(
        {
            "id": "chatcmpl-stub",
            "object": "chat.completion",
            "model": body.get("model", STUB_MODEL),
            "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": len(last_user.split()),
                "completion_tokens": 5,
                "total_tokens": len(last_user.split()) + 5,
            },
        }
    )


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=9001)
    args = parser.parse_args()
    print(f"LLM stub on http://{args.host}:{args.port}  (fixture: {_FIXTURE if _FIXTURE.exists() else 'none'})")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
