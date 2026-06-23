"""생성 LLM 클라이언트(app.ai.llm) 단위 테스트 — mock 결정성, openai 응답 파싱
관대성(reasoning 분리·usage 무관), 백엔드 토글·에러.

Run: cd backend && ./venv/bin/python -m pytest tests/test_ai_llm.py -v
"""
from __future__ import annotations

import pytest

from app.ai import llm
from app.ai.llm import ChatResult, LLMError, _parse_openai_response, chat


def test_mock_is_deterministic(monkeypatch):
    monkeypatch.setattr(llm.settings, "llm_backend", "mock")
    monkeypatch.setattr(llm.settings, "llm_model", "GLM-5-2")
    a = chat([{"role": "user", "content": "안녕"}])
    b = chat([{"role": "user", "content": "안녕"}])
    assert isinstance(a, ChatResult)
    assert a.content == b.content  # 같은 입력 → 같은 출력
    assert "안녕" in a.content
    assert a.backend == "mock"
    assert a.reasoning is None


def test_unknown_backend_raises(monkeypatch):
    monkeypatch.setattr(llm.settings, "llm_backend", "ghost")
    with pytest.raises(LLMError, match="알 수 없는"):
        chat([{"role": "user", "content": "x"}])


def test_openai_parse_strips_reasoning():
    data = {
        "model": "GLM-5-2",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "  최종 답변입니다.  ",
                    "reasoning_content": "  생각하는 중...  ",
                }
            }
        ],
        "usage": {"total_tokens": 42},
    }
    res = _parse_openai_response(data, fallback_model="x")
    assert res.content == "최종 답변입니다."  # 스트립됨
    assert res.reasoning == "생각하는 중..."   # 분리됨
    assert res.usage == {"total_tokens": 42}
    assert res.model == "GLM-5-2"


def test_openai_parse_without_usage_or_reasoning():
    data = {"choices": [{"message": {"content": "답"}}]}
    res = _parse_openai_response(data, fallback_model="fallback-model")
    assert res.content == "답"
    assert res.reasoning is None
    assert res.usage is None
    assert res.model == "fallback-model"  # 응답에 model 없으면 폴백


def test_openai_parse_no_choices_raises():
    with pytest.raises(LLMError, match="choices"):
        _parse_openai_response({"object": "error"}, fallback_model="x")


def test_openai_parse_empty_message_raises():
    data = {"choices": [{"message": {"content": "", "reasoning_content": ""}}]}
    with pytest.raises(LLMError, match="content/reasoning"):
        _parse_openai_response(data, fallback_model="x")


def test_chat_openai_builds_body_and_sends_reasoning(monkeypatch):
    """openai 경로가 base/chat/completions 로 올바른 바디(+reasoning_effort,
    +Authorization)를 보내는지. httpx.post 를 가로채 검증."""
    monkeypatch.setattr(llm.settings, "llm_backend", "openai")
    monkeypatch.setattr(llm.settings, "llm_base_url", "http://stub:9001/v1")
    monkeypatch.setattr(llm.settings, "llm_model", "GLM-5-2")
    monkeypatch.setattr(llm.settings, "llm_api_key", "secret-key")

    captured = {}

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "model": "GLM-5-2",
                "choices": [{"message": {"content": "ok", "reasoning_content": "think"}}],
                "usage": {"total_tokens": 3},
            }

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers
        return _Resp()

    monkeypatch.setattr(llm.httpx, "post", fake_post)

    res = chat([{"role": "user", "content": "hi"}], reasoning_effort="high")

    assert captured["url"] == "http://stub:9001/v1/chat/completions"
    assert captured["json"]["model"] == "GLM-5-2"
    assert captured["json"]["chat_template_kwargs"] == {"reasoning_effort": "high"}
    assert captured["headers"]["Authorization"] == "Bearer secret-key"
    assert res.content == "ok"
    assert res.reasoning == "think"


def test_chat_openai_http_error_wrapped(monkeypatch):
    monkeypatch.setattr(llm.settings, "llm_backend", "openai")

    def boom(*a, **k):
        raise llm.httpx.ConnectError("refused")

    monkeypatch.setattr(llm.httpx, "post", boom)
    with pytest.raises(LLMError, match="호출 실패"):
        chat([{"role": "user", "content": "hi"}])
