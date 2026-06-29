"""LLM 응답 관대 JSON 파서(app.ai.jsonio.extract_json) 단위 테스트.

작은/로컬 모델의 흔한 출력 변형(코드펜스·트레일링콤마·파이썬 리터럴·스마트따옴표·
문자열 내 생제어문자)을 살리고, 잘린 응답은 None 으로 떨어지는지 확인한다.
"""
from __future__ import annotations

from app.ai.jsonio import extract_json


def test_plain_object():
    assert extract_json('{"a": 1, "b": "x"}') == {"a": 1, "b": "x"}


def test_code_fence_and_trailing_comma():
    raw = '```json\n{"a": 1, "b": [1, 2,],}\n```'
    assert extract_json(raw) == {"a": 1, "b": [1, 2]}


def test_raw_newline_in_string():
    # rich_text 본문에 실제 개행 — strict json.loads 는 거부.
    assert extract_json('{"content": "첫 줄\n둘째 줄"}') == {"content": "첫 줄\n둘째 줄"}


def test_python_literals_and_prose_around():
    raw = '설명입니다: {"ok": True, "n": None, "f": False} 끝.'
    assert extract_json(raw) == {"ok": True, "n": None, "f": False}


def test_smart_quotes():
    assert extract_json('{“key”: “값”}') == {"key": "값"}


def test_nested_braces_balanced():
    raw = 'noise {"a": {"b": {"c": 1}}, "d": 2} noise'
    assert extract_json(raw) == {"a": {"b": {"c": 1}}, "d": 2}


def test_truncated_returns_none():
    assert extract_json('{"content": "여기서 잘') is None


def test_no_object_returns_none():
    assert extract_json("그냥 텍스트, JSON 없음") is None
    assert extract_json("") is None
    assert extract_json(None) is None


def test_top_level_array_returns_none():
    # 최상위가 배열이면 dict 가 아니라 None(작성 경로는 객체를 기대).
    assert extract_json("[1, 2, 3]") is None
