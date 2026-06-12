"""위젯 작성 상세 룰(AI 프롬프트용) — **단일 소스**.

`authoring_rules.json` 이 진실의 원천이다. 프런트의 '복사용 프롬프트'(AI 설정)도,
MCP 의 describe_template / describe_widgets 도 모두 이 한 파일을 쓴다. 프런트는
빌드 시 같은 json 을 import 해 임베드하고(widgetExamples.js), 백엔드는 런타임에
읽어 MCP 응답에 실어 보낸다. 새 위젯/룰은 json 한 곳만 고치면 양쪽이 같이 갱신된다.

json 구조: {"preamble": "<전역 주의사항>", "examples": [{"types": [...], "body": "<### 위젯 마크다운>"}]}
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_RULES_PATH = Path(__file__).with_name("authoring_rules.json")


@lru_cache(maxsize=1)
def _data() -> dict:
    with _RULES_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def preamble() -> str:
    """위젯 무관 전역 주의사항(스키마 규칙·환각 패턴·혼동 위젯 쌍·값 타입)."""
    return _data().get("preamble", "")


def covered_types() -> set[str]:
    """예제(상세 룰)가 있는 위젯 타입 집합."""
    return {t for e in _data().get("examples", []) for t in e.get("types", [])}


def body_for_type(widget_type: str) -> str | None:
    """한 위젯 타입의 상세 룰 본문(### 섹션 마크다운). 없으면 None."""
    for e in _data().get("examples", []):
        if widget_type in e.get("types", []):
            return e.get("body")
    return None


def rules_for_types(types: list[str] | set[str]) -> str:
    """주어진 위젯 타입들의 상세 룰 — preamble + 해당 위젯 예제 본문(중복 제거,
    멀티타입 항목은 한 타입만 걸려도 포함). MCP describe_template/describe_widgets 용.

    프런트의 renderWidgetExamplesText 와 같은 조립 규칙."""
    want = set(types or [])
    bodies: list[str] = []
    for e in _data().get("examples", []):
        etypes = e.get("types", [])
        if any(t in want for t in etypes):
            bodies.append(e.get("body", ""))
    if not bodies:
        return preamble()
    return "\n\n".join([preamble(), *bodies])


def all_rules_text() -> str:
    """모든 위젯 상세 룰 전체 텍스트(프런트 WIDGET_EXAMPLES_TEXT 와 동일)."""
    d = _data()
    return "\n\n".join([d.get("preamble", ""), *(e.get("body", "") for e in d.get("examples", []))])
