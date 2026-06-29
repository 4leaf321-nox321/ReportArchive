"""LLM 텍스트 응답에서 JSON 객체를 관대하게 뽑아낸다.

작은/로컬 모델(B300/GLM)은 코드펜스로 감싸거나, 문자열 안에 생개행을 그대로
넣거나, 트레일링 콤마·파이썬 리터럴(True/None)·스마트따옴표를 섞는 일이 잦다.
표준 ``json.loads`` 는 이런 응답을 전부 거부한다. 이 모듈은 단계적으로

  1) 코드펜스 제거 → 균형 중괄호로 첫 완결 객체 추출
  2) ``json.loads``
  3) 실패 시 통상 보정(스마트따옴표·파이썬 리터럴·트레일링 콤마·문자열 내
     제어문자 이스케이프) 후 재시도

순으로 시도하고, 끝내 안 되면 ``None`` 을 돌려준다. JSON 출력 모드
(``chat(json_mode=True)``)를 켜면 대부분 1)에서 끝나지만, 서버가 모드를 지원
하지 않거나 응답이 잘린 경우의 안전망이다.
"""
from __future__ import annotations

import json
import re
from typing import Optional

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)
_TRAILING_COMMA_RE = re.compile(r",\s*([}\]])")
_PY_TRUE_RE = re.compile(r"\bTrue\b")
_PY_FALSE_RE = re.compile(r"\bFalse\b")
_PY_NULL_RE = re.compile(r"\b(?:None|NaN|undefined)\b")


def _strip_fences(text: str) -> str:
    m = _FENCE_RE.search(text)
    return m.group(1).strip() if m else text.strip()


def _first_json_object(text: str) -> Optional[str]:
    """첫 ``{`` 부터 짝이 맞는 ``}`` 까지(문자열·이스케이프 인식). 끝까지 안 닫히면
    (잘린 응답) 시작부터 끝까지를 돌려 보정 단계가 시도하게 둔다."""
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return text[start:]


def _basic_repairs(s: str) -> str:
    s = s.replace("“", '"').replace("”", '"')  # 스마트 큰따옴표
    s = s.replace("‘", "'").replace("’", "'")  # 스마트 작은따옴표
    s = _PY_TRUE_RE.sub("true", s)
    s = _PY_FALSE_RE.sub("false", s)
    s = _PY_NULL_RE.sub("null", s)
    s = _TRAILING_COMMA_RE.sub(r"\1", s)
    return s


def _escape_ctrl_in_strings(s: str) -> str:
    """문자열 값 안의 생(raw) 제어문자를 JSON 이스케이프로. 긴 한글 본문에서 모델이
    실제 개행을 그대로 넣어 ``json.loads`` 가 거부하는 대표 실패 모드를 살린다."""
    out: list[str] = []
    in_str = False
    esc = False
    for ch in s:
        if in_str:
            if esc:
                out.append(ch)
                esc = False
                continue
            if ch == "\\":
                out.append(ch)
                esc = True
                continue
            if ch == '"':
                out.append(ch)
                in_str = False
                continue
            if ch == "\n":
                out.append("\\n")
                continue
            if ch == "\r":
                out.append("\\r")
                continue
            if ch == "\t":
                out.append("\\t")
                continue
            if ord(ch) < 0x20:
                out.append("\\u%04x" % ord(ch))
                continue
            out.append(ch)
        else:
            out.append(ch)
            if ch == '"':
                in_str = True
    return "".join(out)


def extract_json(text: Optional[str]) -> Optional[dict]:
    """LLM 응답 문자열에서 최상위 JSON 객체(dict)를 뽑는다. 실패 시 None."""
    if not text:
        return None
    candidate = _first_json_object(_strip_fences(text))
    if candidate is None:
        return None
    repaired = _basic_repairs(candidate)
    for attempt in (candidate, repaired, _escape_ctrl_in_strings(repaired)):
        try:
            val = json.loads(attempt)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(val, dict):
            return val
    return None
