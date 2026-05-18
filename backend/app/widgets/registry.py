"""The 8 built-in widgets.

Adding a new widget = (1) define props_schema + content_schema_for here,
(2) register a renderer/editor on the frontend.

Content shape convention: every widget that has content stores an OBJECT
under its block id (e.g., `{"markdown": "..."}` or `{"rows": [...]}`).
This keeps `reports.content[block_id]` uniform for all widgets and leaves
room for per-block metadata later.
"""
from __future__ import annotations

from typing import Any, Callable, Optional, TypedDict


# --------------------------------------------------------------------------- #
# Helpers shared between widgets
# --------------------------------------------------------------------------- #
_KV_FIELD_TYPES = ("text", "number", "integer", "date", "select")

# Block-level caption — every widget except `heading` (which already has its
# own `text` slot) carries this optional, free-form heading. When empty the
# report renders the block without a section title; when set, it acts like
# the heading widget's text. See ImageEditor for the original pattern.
_CAPTION_FIELD = {"type": "string", "maxLength": 200}


# Reusable text-style sub-schema. Mixed into every text-bearing widget's
# props_schema so designers can override the visual treatment per block.
# Every field is optional — missing values inherit from the parent CSS so
# the rendered output is unchanged for templates that pre-date this field.
# Applies to body / value text only; structural marks (RichText's depth
# prefix □/–/·, depth indent, relation chips) deliberately stay fixed so
# the outline conventions remain consistent across reports.
_TEXT_STYLE_SCHEMA = {
    "type": "object",
    "properties": {
        "size": {
            "type": "string",
            "enum": ["xs", "sm", "base", "lg", "xl", "2xl"],
        },
        "font_family": {
            "type": "string",
            "enum": ["sans", "serif", "mono"],
        },
        "align": {
            "type": "string",
            "enum": ["left", "center", "right", "justify"],
        },
        "weight": {
            "type": "string",
            "enum": ["normal", "medium", "semibold", "bold"],
        },
    },
    "additionalProperties": False,
}


# RichText only — per-depth overlay on top of `text_style`. Keys are
# the depth string ("0".."2"); depths 3+ inherit "2" (or the base
# `text_style` if "2" is absent). Each value is a sparse text-style
# object with the same shape as _TEXT_STYLE_SCHEMA, so missing fields
# fall through to the base style.
_DEPTH_STYLES_SCHEMA = {
    "type": "object",
    "properties": {
        "0": _TEXT_STYLE_SCHEMA,
        "1": _TEXT_STYLE_SCHEMA,
        "2": _TEXT_STYLE_SCHEMA,
    },
    "additionalProperties": False,
}


def _kv_field_value_schema(item: dict) -> dict:
    """Maps a key_value/table item declaration to a JSON Schema value node."""
    t = item["type"]
    if t == "text":
        return {"type": "string"}
    if t == "number":
        return {"type": "number"}
    if t == "integer":
        return {"type": "integer"}
    if t == "date":
        return {"type": "string", "format": "date"}
    if t == "select":
        return {"type": "string", "enum": list(item.get("options") or [])}
    raise ValueError(f"Unknown field type: {t}")


_FIELD_ITEM_PROPS_SCHEMA = {
    "type": "object",
    "properties": {
        "key": {"type": "string", "pattern": r"^[a-z][a-z0-9_]*$", "maxLength": 64},
        "label": {"type": "string", "minLength": 1, "maxLength": 200},
        "type": {"type": "string", "enum": list(_KV_FIELD_TYPES)},
        "options": {"type": "array", "items": {"type": "string", "minLength": 1}},
        "required": {"type": "boolean"},
        # Optional ontology / linking hints — see validation.META_SCHEMA.
        "meta": {"type": "object"},
    },
    "required": ["key", "label", "type"],
    "additionalProperties": False,
}


# --------------------------------------------------------------------------- #
# Widget descriptor type
# --------------------------------------------------------------------------- #
class WidgetDescriptor(TypedDict, total=False):
    type: str
    label: str
    description: str
    has_content: bool
    props_schema: dict
    content_schema_for: Callable[[dict], Optional[dict]]
    default_props: dict


# --------------------------------------------------------------------------- #
# 1. heading — section title; level fixed at template, text filled at report
# --------------------------------------------------------------------------- #
HEADING: WidgetDescriptor = {
    "type": "heading",
    "label": "제목",
    "description": "섹션 제목. level은 템플릿이 잠그고, 텍스트는 보고서 작성자가 입력 (default_text로 미리 채울 수 있음).",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "level": {"type": "integer", "enum": [1, 2, 3]},
            "default_text": {"type": "string", "maxLength": 200},
            "text_style": _TEXT_STYLE_SCHEMA,
        },
        "required": ["level"],
        "additionalProperties": False,
    },
    "content_schema_for": lambda props: {
        "type": "object",
        "properties": {
            "text": {"type": "string", "maxLength": 200},
        },
        "required": ["text"],
        "additionalProperties": False,
    },
    "default_props": {"level": 2},
}


# --------------------------------------------------------------------------- #
# 2. rich_text — markdown / 자유 서술
# --------------------------------------------------------------------------- #
def _rich_text_content(props: dict) -> dict:
    md_schema: dict[str, Any] = {"type": "string"}
    if "min_length" in props:
        md_schema["minLength"] = props["min_length"]
    if "max_length" in props:
        md_schema["maxLength"] = props["max_length"]
    # New structured form: an outline of items {depth, text, html?, relation?}.
    # `text` is the plain-text mirror of `html` (used for AI prompts and
    # search). `html` is the canonical rich-text representation written by
    # the TipTap editor — wraps text in a single <p> with optional
    # bold/italic/underline marks and `<span style="...">` for color /
    # font-size. Sanitized on render via DOMPurify; the maxLength here
    # bounds the worst-case markup overhead vs. the 2000-char text.
    # `relation` is a free-form slug validated only for shape — the actual
    # vocabulary lives in the widget_relations table so admins can add or
    # rename entries without a schema migration.
    item_schema = {
        "type": "object",
        "properties": {
            "depth": {"type": "integer", "minimum": 0, "maximum": 5},
            "text": {"type": "string", "maxLength": 2000},
            "html": {"type": "string", "maxLength": 8000},
            "relation": {
                "type": "string",
                "minLength": 1,
                "maxLength": 32,
                "pattern": r"^[a-z0-9][a-z0-9_-]*$",
            },
        },
        "required": ["depth", "text"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            # Legacy single-blob field — still accepted for backward
            # compatibility. The frontend parses it into `items` on load
            # and writes back as `items`. Validators that need the body
            # length should look at either field.
            "markdown": md_schema,
            "items": {"type": "array", "items": item_schema},
        },
        # Body fields are intentionally optional during draft state — the
        # report writer can fill caption first, body later.
        "additionalProperties": False,
    }


RICH_TEXT: WidgetDescriptor = {
    "type": "rich_text",
    "label": "긴 글",
    "description": "마크다운으로 자유 서술 (이슈, 회고, 분석 등)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            "placeholder": {"type": "string", "maxLength": 500},
            "min_length": {"type": "integer", "minimum": 0},
            "max_length": {"type": "integer", "minimum": 1},
            "required": {"type": "boolean"},
            # When true, the editor's textarea grows with content (no inner
            # scroll) and the rendered grid item's row height is content-
            # driven instead of clamped to layout.row_span.
            "expand_with_content": {"type": "boolean"},
            "text_style": _TEXT_STYLE_SCHEMA,
            "depth_styles": _DEPTH_STYLES_SCHEMA,
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _rich_text_content,
    "default_props": {"label": "내용", "required": False},
}


# --------------------------------------------------------------------------- #
# 3. key_value — 라벨–값 쌍 (메타정보)
# --------------------------------------------------------------------------- #
def _key_value_content(props: dict) -> dict:
    items = props.get("items", [])
    properties = {"caption": _CAPTION_FIELD}
    for item in items:
        properties[item["key"]] = _kv_field_value_schema(item)
    return {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
        # Per-item `required: True` is now a UI hint only — body fields stay
        # optional in the schema so caption-only drafts validate.
    }


KEY_VALUE: WidgetDescriptor = {
    "type": "key_value",
    "label": "키-값",
    "description": "메타정보 입력 (작성자, 보고일, 부서 등)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "maxLength": 200},
            "items": {
                "type": "array",
                "minItems": 1,
                "items": _FIELD_ITEM_PROPS_SCHEMA,
            },
            "text_style": _TEXT_STYLE_SCHEMA,
        },
        "required": ["items"],
        "additionalProperties": False,
    },
    "content_schema_for": _key_value_content,
    "default_props": {
        "label": "메타정보",
        "items": [
            {"key": "period", "label": "보고 기간", "type": "text", "required": True},
            {"key": "owner", "label": "작성자", "type": "text", "required": True},
        ],
    },
}


# --------------------------------------------------------------------------- #
# 4. bulleted_list — 가변 길이 텍스트 리스트
# --------------------------------------------------------------------------- #
def _bulleted_list_content(props: dict) -> dict:
    items_schema: dict[str, Any] = {"type": "string", "minLength": 1}
    arr_schema: dict[str, Any] = {"type": "array", "items": items_schema}
    if "min_items" in props:
        arr_schema["minItems"] = props["min_items"]
    if "max_items" in props:
        arr_schema["maxItems"] = props["max_items"]
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "items": arr_schema,
        },
        "additionalProperties": False,
    }


BULLETED_LIST: WidgetDescriptor = {
    "type": "bulleted_list",
    "label": "글머리 리스트",
    "description": "한 줄짜리 항목 여러 개 (이번주 한 일, 다음주 계획 등)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            "placeholder": {"type": "string", "maxLength": 200},
            "min_items": {"type": "integer", "minimum": 0},
            "max_items": {"type": "integer", "minimum": 1},
            "text_style": _TEXT_STYLE_SCHEMA,
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _bulleted_list_content,
    "default_props": {"label": "항목"},
}


# --------------------------------------------------------------------------- #
# 5. table — 열 잠금, 행 추가
# --------------------------------------------------------------------------- #
def _table_content(props: dict) -> dict:
    # Reports may extend or fully redefine the column set per instance —
    # `content.columns` (when present) takes precedence over `props.columns`.
    # Because the column shape is then runtime-driven, row keys can't be
    # constrained at the JSON Schema level; rows accept any object whose
    # values are primitives. Strict per-column type checks happen during
    # editing in the UI, not at the schema layer.
    rows_schema: dict[str, Any] = {
        "type": "array",
        "items": {
            "type": "object",
            "additionalProperties": True,
        },
    }
    if "min_rows" in props:
        rows_schema["minItems"] = props["min_rows"]
    if "max_rows" in props:
        rows_schema["maxItems"] = props["max_rows"]
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            # Per-report column overrides. When absent, the renderer falls
            # back to props.columns (the template-defined defaults).
            "columns": {
                "type": "array",
                "items": _FIELD_ITEM_PROPS_SCHEMA,
            },
            "rows": rows_schema,
        },
        "additionalProperties": False,
    }


TABLE: WidgetDescriptor = {
    "type": "table",
    "label": "표",
    "description": "템플릿이 열을 정의하고 보고서가 행을 채움",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            "columns": {
                "type": "array",
                "minItems": 1,
                "items": _FIELD_ITEM_PROPS_SCHEMA,
            },
            "min_rows": {"type": "integer", "minimum": 0},
            "max_rows": {"type": "integer", "minimum": 1},
            "text_style": _TEXT_STYLE_SCHEMA,
        },
        "required": ["label", "columns"],
        "additionalProperties": False,
    },
    "content_schema_for": _table_content,
    "default_props": {
        "label": "표",
        "columns": [
            {"key": "name", "label": "이름", "type": "text", "required": True},
            {"key": "value", "label": "값", "type": "text"},
        ],
    },
}


# --------------------------------------------------------------------------- #
# 6. kpi_card — 헤드라인 지표
# --------------------------------------------------------------------------- #
def _kpi_card_content(props: dict) -> dict:
    schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "value": {"type": "number"},
        },
        "additionalProperties": False,
    }
    if props.get("allow_delta"):
        schema["properties"]["delta"] = {"type": "number"}
    if props.get("allow_note"):
        schema["properties"]["note"] = {"type": "string", "maxLength": 500}
    return schema


KPI_CARD: WidgetDescriptor = {
    "type": "kpi_card",
    "label": "KPI 카드",
    "description": "단일 헤드라인 지표 (값 + 단위 + 선택적 증감/메모)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            "unit": {"type": "string", "maxLength": 32},
            "format": {"type": "string", "enum": ["number", "percent", "currency"]},
            "target": {"type": "number"},
            "allow_delta": {"type": "boolean"},
            "allow_note": {"type": "boolean"},
            "text_style": _TEXT_STYLE_SCHEMA,
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _kpi_card_content,
    "default_props": {"label": "지표", "format": "number", "allow_delta": True, "allow_note": False},
}


# --------------------------------------------------------------------------- #
# 7. image — 이미지 1~N장
# --------------------------------------------------------------------------- #
def _image_content(props: dict) -> dict:
    item_props: dict[str, Any] = {
        "file_id": {"type": "string", "minLength": 1},
        "caption": {"type": "string", "maxLength": 500},
        "alt": {"type": "string", "maxLength": 200},
    }
    item_required = ["file_id"]
    if props.get("caption_required"):
        item_required.append("caption")
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "files": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": item_props,
                    "required": item_required,
                    "additionalProperties": False,
                },
                "minItems": 0,
                "maxItems": props.get("max_count", 10),
            },
        },
        "additionalProperties": False,
    }


IMAGE: WidgetDescriptor = {
    "type": "image",
    "label": "이미지",
    "description": "이미지 1장 또는 갤러리 (max_count로 결정)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            "max_count": {"type": "integer", "minimum": 1, "maximum": 50},
            "caption_required": {"type": "boolean"},
            "aspect_ratio": {
                "type": "string",
                "pattern": r"^\d+:\d+$",
                "description": "예: '16:9', '4:3', '1:1'",
            },
        },
        "required": ["label", "max_count"],
        "additionalProperties": False,
    },
    "content_schema_for": _image_content,
    "default_props": {"label": "이미지", "max_count": 1},
}


# --------------------------------------------------------------------------- #
# 8. attachment — 비-이미지 파일 첨부
# --------------------------------------------------------------------------- #
def _attachment_content(props: dict) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "files": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "file_id": {"type": "string", "minLength": 1},
                        "filename": {"type": "string", "minLength": 1, "maxLength": 255},
                        "size": {"type": "integer", "minimum": 0},
                    },
                    "required": ["file_id", "filename"],
                    "additionalProperties": False,
                },
                "minItems": 0,
                "maxItems": props.get("max_count", 10),
            }
        },
        "additionalProperties": False,
    }


ATTACHMENT: WidgetDescriptor = {
    "type": "attachment",
    "label": "첨부 파일",
    "description": "PDF, 스프레드시트 등 다운로드 카드로 표시되는 파일",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            "max_count": {"type": "integer", "minimum": 1, "maximum": 50},
            "allowed_extensions": {
                "type": "array",
                "items": {"type": "string", "pattern": r"^\.[a-zA-Z0-9]+$"},
            },
        },
        "required": ["label", "max_count"],
        "additionalProperties": False,
    },
    "content_schema_for": _attachment_content,
    "default_props": {"label": "첨부", "max_count": 5},
}


# --------------------------------------------------------------------------- #
# 9. chart — bar / line chart over tabular data
# --------------------------------------------------------------------------- #
_CHART_TYPES = ("bar", "line")

# Charts use a slimmer column model than `table` — only x (categorical) and
# number series. Reusing a separate item schema keeps validation tight.
_CHART_COLUMN_SCHEMA = {
    "type": "object",
    "properties": {
        "key": {"type": "string", "pattern": r"^[a-z][a-z0-9_]*$", "maxLength": 64},
        "label": {"type": "string", "minLength": 1, "maxLength": 200},
        "type": {"type": "string", "enum": ["text", "number"]},
        # Optional ontology / linking hints — see validation.META_SCHEMA.
        "meta": {"type": "object"},
    },
    "required": ["key", "label", "type"],
    "additionalProperties": False,
}


def _chart_content(props: dict) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            # Per-report overrides — type stored alongside data so the
            # report can flip bar↔line without going back to the template.
            "chart_type": {"type": "string", "enum": list(_CHART_TYPES)},
            "x_column_key": {"type": "string", "pattern": r"^[a-z][a-z0-9_]*$"},
            "x_axis_title": {"type": "string", "maxLength": 100},
            "y_axis_title": {"type": "string", "maxLength": 100},
            "columns": {
                "type": "array",
                "items": _CHART_COLUMN_SCHEMA,
            },
            "rows": {
                "type": "array",
                "items": {"type": "object", "additionalProperties": True},
            },
        },
        "additionalProperties": False,
    }


CHART: WidgetDescriptor = {
    "type": "chart",
    "label": "그래프",
    "description": "표 데이터로 그리는 막대 / 꺾은선 그래프 (보고서에서 전환 가능)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            "chart_type": {"type": "string", "enum": list(_CHART_TYPES)},
            "x_column_key": {
                "type": "string",
                "pattern": r"^[a-z][a-z0-9_]*$",
                "maxLength": 64,
            },
            "x_axis_title": {"type": "string", "maxLength": 100},
            "y_axis_title": {"type": "string", "maxLength": 100},
            "columns": {
                "type": "array",
                "minItems": 2,
                "items": _CHART_COLUMN_SCHEMA,
            },
        },
        "required": ["label", "chart_type", "x_column_key", "columns"],
        "additionalProperties": False,
    },
    "content_schema_for": _chart_content,
    "default_props": {
        "label": "그래프",
        "chart_type": "bar",
        "x_column_key": "category",
        "columns": [
            {"key": "category", "label": "구분", "type": "text"},
            {"key": "value", "label": "값", "type": "number"},
        ],
    },
}


# --------------------------------------------------------------------------- #
# Registry
# --------------------------------------------------------------------------- #
WIDGET_REGISTRY: dict[str, WidgetDescriptor] = {
    w["type"]: w
    for w in (
        HEADING,
        RICH_TEXT,
        KEY_VALUE,
        BULLETED_LIST,
        TABLE,
        KPI_CARD,
        IMAGE,
        ATTACHMENT,
        CHART,
    )
}


def get_widget(type_: str) -> WidgetDescriptor:
    if type_ not in WIDGET_REGISTRY:
        raise ValueError(f"Unknown widget type: {type_}")
    return WIDGET_REGISTRY[type_]


def list_widget_descriptors() -> list[dict]:
    """Public catalog for the frontend (omits Python callables)."""
    out = []
    for w in WIDGET_REGISTRY.values():
        out.append(
            {
                "type": w["type"],
                "label": w["label"],
                "description": w["description"],
                "has_content": w["has_content"],
                "props_schema": w["props_schema"],
                "default_props": w.get("default_props", {}),
            }
        )
    return out
