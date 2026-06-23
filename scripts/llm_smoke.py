"""생성 LLM 스모크 — 브라우저 없이(SSH·크론) 연결을 빠르게 확인한다.

진단 탭과 같은 app.ai.llm.chat 을 호출한다. **운영서버에서** 실행하면 실제 B300
연결·model id·응답 모양·지연·reasoning 필드를 확인할 수 있다(진단 탭의 CLI 판).

실행 (backend venv 로):
    cd backend && ./venv/bin/python ../scripts/llm_smoke.py
    cd backend && ./venv/bin/python ../scripts/llm_smoke.py --prompt "한 문장 요약 테스트"

현재 백엔드(LLM_BACKEND)에 따라 mock/ollama/openai 중 하나로 간다(.env 기준).
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

# backend 를 import 경로에 (scripts 에서 직접 실행 대비).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.ai.llm import LLMError, chat, list_models  # noqa: E402
from app.config import settings  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", default="Reply with a one-sentence hello.")
    args = parser.parse_args()

    print(f"backend = {settings.llm_backend}")
    print(f"base_url= {settings.llm_base_url}")
    print(f"model   = {settings.llm_model}")
    print(f"api_key = {'set' if settings.llm_api_key else '(none)'}")
    print("-" * 60)

    try:
        print(f"models  = {list_models()}")
    except LLMError as exc:
        print(f"models  = (조회 실패: {exc})")

    t0 = time.perf_counter()
    try:
        res = chat([{"role": "user", "content": args.prompt}])
    except LLMError as exc:
        print(f"\n❌ chat 실패: {exc}")
        return 1
    ms = int((time.perf_counter() - t0) * 1000)

    print("-" * 60)
    print(f"✅ ok · {ms}ms · model={res.model} · reasoning={'yes' if res.reasoning else 'no'}")
    print(f"usage   = {res.usage}")
    print(f"content = {res.content[:500]}")
    if res.reasoning:
        print(f"reason  = {res.reasoning[:300]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
