"""카드 위젯 — 스키마 검증 · 참조 카테고리 등록 · variant/아이콘 허용셋.

카드는 엔티티를 승격하지 않으므로(저장 훅 무관) 순수 스키마 레벨 테스트다.
등록 자체(default_props 검증 · content_schema_for 호출 가능)는 test_widgets.py 가
전 위젯 공통으로 커버하므로, 여기서는 카드 고유 규약만 본다.
"""
from __future__ import annotations

import pytest
from jsonschema import ValidationError, validate

from app.widgets.registry import (
    REF_CATEGORY_BY_TYPE,
    WIDGET_REGISTRY,
    get_widget,
)


def _schema(props: dict | None = None) -> dict:
    desc = get_widget("card")
    return desc["content_schema_for"](props if props is not None else desc["default_props"])


def test_card_registered_and_not_numbered():
    assert "card" in WIDGET_REGISTRY
    # 그림/표 번호 카운트를 오염시키면 안 된다 — 비번호(None).
    assert REF_CATEGORY_BY_TYPE["card"] is None


def test_card_minimal_and_full_content_validate():
    schema = _schema()
    # 초안 상태 — 제목만. 필수 필드가 없어야 한다.
    validate({"title": "연결 탐색"}, schema)
    # 빈 카드도 저장 가능(작성 시작 직후).
    validate({}, schema)

    # 전체 필드.
    validate(
        {
            "variant": "filled",
            "accent": "teal",
            "icon": "network",
            "eyebrow": "①",
            "title": "연결 탐색",
            "body": {"items": [{"depth": 0, "text": "관련 시험·문서 즉시 연계"}]},
            "badge": {"text": "완료", "tone": "success"},
            "stat": {"value": "128", "unit": "건"},
            "footnote": "2026-07 기준",
            "caption": "요약",
            "caption_position": "below",
        },
        schema,
    )


@pytest.mark.parametrize("variant", ["soft", "outline", "filled", "banner"])
def test_card_all_variants_valid(variant):
    validate({"variant": variant}, _schema())


def test_card_rejects_unknown_variant_and_tone():
    schema = _schema()
    with pytest.raises(ValidationError):
        validate({"variant": "glass"}, schema)
    with pytest.raises(ValidationError):
        validate({"badge": {"text": "x", "tone": "danger"}}, schema)


def test_card_accent_is_bare_token_not_class():
    """저장값은 'teal' — 'rt-c-teal' 같은 클래스명이 들어오면 거부해야 한다.

    (설계 문서 초안이 'rt-c-teal' 로 적혀 있었으나 실제 규약은 접두사 없는 토큰.)
    """
    schema = _schema()
    validate({"accent": "teal"}, schema)
    with pytest.raises(ValidationError):
        validate({"accent": "rt-c-teal"}, schema)
    with pytest.raises(ValidationError):
        validate({"accent": "#0d9488"}, schema)


def test_card_icon_allowlist_enforced():
    schema = _schema()
    validate({"icon": "target"}, schema)
    # 허용셋 밖의 임의 lucide 이름은 거부 — 프론트가 정적 import 한 것만 렌더된다.
    with pytest.raises(ValidationError):
        validate({"icon": "rocket"}, schema)


def test_card_body_reuses_outline_item_shape():
    """본문은 긴 글(rich_text)과 같은 개요 항목 형식이어야 한다(렌더러 공유)."""
    schema = _schema()
    validate(
        {"body": {"items": [
            {"depth": 0, "text": "상위", "html": "<p>상위</p>"},
            {"depth": 1, "text": "하위"},
        ]}},
        schema,
    )
    # depth/text 는 필수.
    with pytest.raises(ValidationError):
        validate({"body": {"items": [{"text": "깊이 없음"}]}}, schema)


def test_card_rejects_unknown_top_level_key():
    with pytest.raises(ValidationError):
        validate({"titel": "오타"}, _schema())


# --------------------------------------------------------------------------- #
# AI 느슨 입력 정규화 — LLM 이 내는 흔한 모양이 검증을 통과하는지                 #
# --------------------------------------------------------------------------- #
def _norm(raw):
    """(정규화된 content, warnings) — 정규화 결과가 스키마도 통과하는지 함께 본다."""
    from app.modules.reports.ai_authoring import _normalize_block

    warnings: list[str] = []
    out = _normalize_block("card", raw, {}, warnings, "b1")
    if out is not None:
        validate(out, _schema())
    return out, warnings


def test_card_ai_bare_string_becomes_title():
    out, _ = _norm("연결 탐색")
    assert out == {"title": "연결 탐색"}


def test_card_ai_key_aliases():
    out, _ = _norm({"heading": "연결 탐색", "text": "관련 시험 즉시 연계", "color": "teal"})
    assert out["title"] == "연결 탐색"
    assert out["accent"] == "teal"
    assert out["body"]["items"][0]["text"] == "관련 시험 즉시 연계"


def test_card_ai_class_prefixed_accent_is_salvaged():
    """'rt-c-teal' 은 흔한 실수 — 접두사만 벗겨 살린다(버리지 않음)."""
    out, warnings = _norm({"title": "x", "accent": "rt-c-teal"})
    assert out["accent"] == "teal"
    assert not warnings


def test_card_ai_bad_enums_dropped_with_warning():
    out, warnings = _norm(
        {"title": "x", "variant": "glass", "accent": "#0d9488", "icon": "rocket"}
    )
    # 스키마를 깨뜨리는 대신 버리고 경고 — 저장 전체가 422 되는 것보다 낫다.
    assert "variant" not in out and "accent" not in out and "icon" not in out
    assert len(warnings) == 3


def test_card_ai_badge_string_infers_tone():
    out, _ = _norm({"title": "x", "badge": "완료"})
    assert out["badge"] == {"text": "완료", "tone": "success"}
    out2, _ = _norm({"title": "x", "badge": "알수없는말"})
    assert out2["badge"]["tone"] == "neutral"


def test_card_ai_stat_string_split_into_value_unit():
    out, _ = _norm({"title": "x", "stat": "128건"})
    assert out["stat"] == {"value": "128", "unit": "건"}
    # 숫자만 오면 단위 없음.
    out2, _ = _norm({"title": "x", "stat": 42})
    assert out2["stat"] == {"value": "42"}


def test_card_ai_empty_input_returns_none():
    out, _ = _norm({})
    assert out is None
