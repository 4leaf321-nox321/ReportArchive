"""운영 게이트 — B300(GLM)이 function-calling(tools)을 지원하는지 확인.

온톨로지 에이전트(app/ai/agent.py)는 LLM이 tool_calls 를 내보내야 동작한다. 실
B300 은 운영에만 있으므로, **운영 서버에서 이 스크립트를 1회 실행**해 확인한다:

    venv/bin/python scripts/check_tool_calling.py

app 의 실제 LLM 설정(LLM_BACKEND/BASE_URL/MODEL)과 실제 도구 스키마
(agent_tools.TOOL_SCHEMAS)로 한 번 호출한다. 응답에 tool_calls 가 오면 통과 →
에이전트 모드를 신뢰하고 릴리스할 수 있다. 안 오면 서빙 설정(도구 파서 활성화)을
확인해야 한다. API 키는 출력하지 않는다.
"""
from __future__ import annotations

import sys

from app.ai.agent_tools import TOOL_SCHEMAS
from app.ai.llm import chat
from app.config import settings


def main() -> int:
    print(f"backend={settings.llm_backend} model={settings.llm_model} "
          f"base={settings.llm_base_url}")
    if (settings.llm_backend or "mock").lower() != "openai":
        print("!! LLM_BACKEND 가 openai(B300)가 아닙니다 — 운영에서 실행하세요.")
        return 2

    # 도구를 쓸 수밖에 없는 질문(온톨로지 조사) — GLM 이 tool_calls 를 내보내야 정상.
    messages = [
        {"role": "system", "content":
         "너는 온톨로지 분석가다. 어휘가 불확실하면 list_object_types 를 호출하라."},
        {"role": "user", "content": "우리 아카이브에 어떤 종류의 객체가 있어?"},
    ]
    try:
        res = chat(messages, tools=TOOL_SCHEMAS, tool_choice="auto")
    except Exception as exc:  # noqa: BLE001
        print("ERROR:", type(exc).__name__, str(exc)[:400])
        return 1

    if res.tool_calls:
        print("PASS — function-calling 지원됨. tool_calls:")
        for tc in res.tool_calls:
            print("  ->", tc.get("name"), tc.get("arguments"))
        return 0
    print("FAIL — tool_calls 가 없습니다. content:")
    print(" ", (res.content or "")[:400])
    print("→ 서빙 스택의 도구-콜 파서 활성화(vLLM --enable-auto-tool-choice 등)를 확인하세요.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
