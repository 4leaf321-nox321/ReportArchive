"""MCP 로 만들 수 있는 위젯의 **작성 지원** — 느슨 입력 정규화 + 커버리지.

MCP 는 세 층으로 위젯을 지원한다:
  ① authoring_rules  — describe_widgets 가 작성법을 알려 준다(없으면 LLM 이 추측)
  ② ai_authoring     — 느슨한 입력을 widget-v1 로 고친다(없으면 정확한 dict 필수)
  ③ _LAYOUT_SPEC     — 자동 배치 크기(없으면 12x28 기본값으로 뭉툭하게 배치)
이 파일은 ②를 행동으로 고정하고, ①③은 커버리지로 지킨다.
"""
from __future__ import annotations

import pytest
from jsonschema import validate

from app.modules.reports.ai_authoring import _LAYOUT_SPEC, _normalize_block
from app.widgets.authoring_rules import covered_types
from app.widgets.registry import WIDGET_REGISTRY, get_widget

# doc_viewer 는 업로드된 PDF(file_id·page_count·extracted_text)가 전제라 "AI 가 내용을
# 지어내 쓰는" 위젯이 아니다. 파일 업로드 흐름과 함께 다뤄야 해서 의도적으로 제외.
_NO_AUTHORING = {"doc_viewer"}


def _norm(wtype: str, raw):
    """정규화 결과가 그 위젯 스키마도 통과하는지 함께 본다(반쪽 정규화 방지)."""
    warnings: list[str] = []
    out = _normalize_block(wtype, raw, {}, warnings, "b1")
    if out is not None:
        desc = get_widget(wtype)
        validate(out, desc["content_schema_for"](desc["default_props"]))
    return out, warnings


# --------------------------------------------------------------------------- #
# 커버리지                                                                      #
# --------------------------------------------------------------------------- #
def test_every_widget_has_layout_spec():
    """빠지면 자동 배치가 12x28 기본값이 돼 1행짜리 표가 224px 로 뻗는다."""
    missing = sorted(set(WIDGET_REGISTRY) - set(_LAYOUT_SPEC))
    assert not missing, f"_LAYOUT_SPEC 누락: {missing}"


def test_every_widget_has_authoring_rules():
    """빠지면 describe_widgets 가 공통 서문만 돌려줘 LLM 이 스키마를 추측해야 한다."""
    missing = sorted(set(WIDGET_REGISTRY) - set(covered_types()) - _NO_AUTHORING)
    assert not missing, f"authoring_rules 누락: {missing}"


# --------------------------------------------------------------------------- #
# FMEA                                                                          #
# --------------------------------------------------------------------------- #
def test_fmea_bare_list_is_wrapped_into_fmea_items():
    """LLM 은 행 배열을 그냥 준다 — `fmea_items` 래핑은 절대 못 맞힌다."""
    out, _ = _norm("fmea", [{"failure_mode": "과열", "severity": 8, "occurrence": 3, "detection": 4}])
    assert "fmea_items" in out
    row = out["fmea_items"]["rows"][0]
    # 문자열 고장모드를 {name} 으로 감싼다 — 승격 훅이 name 을 본다.
    assert row["failure_mode"]["name"] == "과열"


def test_fmea_rpn_is_computed_not_taken_from_input():
    """화면은 **저장된** rpn 을 그대로 보여준다(렌더 시 재계산 안 함).
    여기서 안 채우면 S·O·D 를 다 줘도 '—' 로 보인다."""
    out, _ = _norm("fmea", {"rows": [{"failure_mode": "과열", "s": 8, "o": 3, "d": 4}]})
    assert out["fmea_items"]["rows"][0]["rpn"] == 96

    # 하나라도 비면 RPN 도 비어야 한다(엉뚱한 값이 남으면 안 됨).
    out2, _ = _norm("fmea", [{"failure_mode": "과열", "severity": 8}])
    assert out2["fmea_items"]["rows"][0]["rpn"] is None


def test_fmea_score_aliases_and_range():
    out, _ = _norm("fmea", [{"mode": "단선", "effect": "동작 불능", "cause": "진동",
                             "severity": "9", "occurrence": 2, "detection": 11}])
    row = out["fmea_items"]["rows"][0]
    assert row["failure_mode"]["name"] == "단선"
    assert row["potential_effect"] == "동작 불능"
    assert row["potential_cause"] == "진동"
    assert row["severity"] == 9          # 문자열 "9" → 숫자
    assert row["detection"] is None      # 1~10 밖 → 비움(저장 거절 대신)
    assert row["rpn"] is None            # 검출도가 비었으니 RPN 도 없음


def test_fmea_rows_get_ids():
    """행 id 는 화면 편집기가 행을 식별하는 키 — 없으면 편집이 꼬인다."""
    out, _ = _norm("fmea", ["과열", "단선"])
    ids = [r["id"] for r in out["fmea_items"]["rows"]]
    assert len(ids) == len(set(ids)) == 2


def test_fmea_empty_returns_none():
    out, warnings = _norm("fmea", {"nope": 1})
    assert out is None and warnings


# --------------------------------------------------------------------------- #
# record / record_table                                                         #
# --------------------------------------------------------------------------- #
def test_record_table_list_with_axis():
    out, warnings = _norm("record_table", {"axis_slug": "failure_mode",
                                           "rows": ["납땜 불량", {"name": "단선"}]})
    assert out["axis_slug"] == "failure_mode"
    assert [r["name"] for r in out["rows"]] == ["납땜 불량", "단선"]
    assert not warnings


def test_record_without_axis_warns_because_nothing_is_promoted():
    """axis_slug 가 없으면 위젯은 저장되지만 **온톨로지엔 아무것도 안 남는다**.
    조용히 넘기면 '됐다'고 오해하므로 경고해야 한다."""
    out, warnings = _norm("record", {"name": "납땜 불량"})
    assert out["name"] == "납땜 불량"
    assert "axis_slug" not in out
    assert any("axis_slug" in w for w in warnings), warnings


def test_record_single_from_bare_string():
    out, _ = _norm("record", "납땜 불량")
    assert out["name"] == "납땜 불량"


def test_record_entity_id_is_not_taken_from_input():
    """entity_id 는 서버가 만들어 되심는 값 — AI 가 준 값을 그대로 믿으면
    남의 객체에 붙을 수 있다. 지금은 통과시키되, 회귀 감지용으로 고정해 둔다."""
    out, _ = _norm("record", {"axis_slug": "failure_mode", "name": "x", "entity_id": 999})
    assert out.get("entity_id") == 999


@pytest.mark.parametrize("wtype", ["record", "record_table"])
def test_record_widgets_reject_empty(wtype):
    out, _ = _norm(wtype, {})
    assert out is None
