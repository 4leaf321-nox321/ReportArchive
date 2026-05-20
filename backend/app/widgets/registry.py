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


# Annotation data model — shared by every visual widget that hosts an
# annotation layer (chart, image, milestone, possibly more). Lives here
# (rather than in validation.py) to break a circular import: validation
# already pulls WIDGET_REGISTRY from this module.
#
# Coordinate space is per-annotation so the same shape describes a
# "March 2026" mark on a chart and a "top-right corner" mark on an
# image. The host widget's adapter knows how to convert.
#
# Keep in sync with frontend/src/shared/annotations/types.js.
_ANNOTATION_TYPES = ("vline", "vrange", "hline", "hrange", "point", "rect", "arrow", "text")
_ANNOTATION_COORD_SPACES = ("data", "data_relative", "image_pct")
_ANNOTATION_LABEL_POSITIONS = ("auto", "top", "bottom", "inside", "left", "right")
_ANNOTATION_BORDER_STYLES = ("solid", "dashed", "dotted")
_ANNOTATION_Z_ORDERS = ("front", "back")

# Geometry is loose — `additionalProperties: True` so each type carries
# only the fields it needs. Frontend validates the per-type field list;
# backend just enforces "coords are numbers or strings, structure isn't
# obviously malformed."
_ANNOTATION_GEOMETRY_SCHEMA = {
    "type": "object",
    "additionalProperties": True,
    "properties": {
        "x": {"type": ["number", "string"]},
        "y": {"type": ["number", "string"]},
        "x_from": {"type": ["number", "string"]},
        "x_to": {"type": ["number", "string"]},
        "y_from": {"type": ["number", "string"]},
        "y_to": {"type": ["number", "string"]},
        "from": {
            "type": "object",
            "properties": {
                "x": {"type": ["number", "string"]},
                "y": {"type": ["number", "string"]},
            },
            "additionalProperties": False,
        },
        "to": {
            "type": "object",
            "properties": {
                "x": {"type": ["number", "string"]},
                "y": {"type": ["number", "string"]},
            },
            "additionalProperties": False,
        },
    },
}

ANNOTATION_SCHEMA = {
    "type": "object",
    "properties": {
        "id": {"type": "string", "minLength": 1, "maxLength": 64},
        "type": {"type": "string", "enum": list(_ANNOTATION_TYPES)},
        "coord_space": {"type": "string", "enum": list(_ANNOTATION_COORD_SPACES)},
        "geometry": _ANNOTATION_GEOMETRY_SCHEMA,
        "label": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "maxLength": 500},
                "position": {
                    "type": "string",
                    "enum": list(_ANNOTATION_LABEL_POSITIONS),
                },
            },
            "required": ["text"],
            "additionalProperties": False,
        },
        "style": {
            "type": "object",
            "properties": {
                "color": {"type": "string", "maxLength": 64},
                "opacity": {"type": "number", "minimum": 0, "maximum": 1},
                "border": {"type": "string", "enum": list(_ANNOTATION_BORDER_STYLES)},
                "z": {"type": "string", "enum": list(_ANNOTATION_Z_ORDERS)},
            },
            "additionalProperties": False,
        },
        "locked": {"type": "boolean"},
        "hidden": {"type": "boolean"},
        "series_key": {
            "type": "string",
            "pattern": r"^[a-z][a-z0-9_]*$",
            "maxLength": 64,
        },
    },
    "required": ["id", "type", "geometry"],
    "additionalProperties": False,
}

# Reusable `content.annotations` field shape. Visual widgets all share
# this — bumping the soft cap here lifts it everywhere consistently.
_ANNOTATIONS_FIELD = {
    "type": "array",
    "items": ANNOTATION_SCHEMA,
    "maxItems": 200,
}


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
        # Numeric pixel font size. Emitted by the current UI as an inline
        # CSS value so it always wins over the Tailwind utility classes the
        # widgets ship with (heading levels, body-text defaults). Range is
        # generous on purpose — the UI exposes a curated dropdown but
        # custom values typed by future tooling stay valid.
        "font_size_px": {"type": "integer", "minimum": 6, "maximum": 200},
        # Legacy size enum. Kept solely for templates saved before the
        # numeric switch; the UI no longer offers these values. Render-time
        # code reads `font_size_px` first and falls back to mapping this
        # enum onto a px value.
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
        # When true (key_value only — ignored by table cells), the content
        # value is a list of entries instead of a single scalar.
        "multi": {"type": "boolean"},
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
        scalar = _kv_field_value_schema(item)
        # `multi=True` items hold an array of values per key — lets one
        # field carry multiple entries (e.g. several defect types under
        # the single "불량 종류" key) without forking off another widget.
        if item.get("multi"):
            properties[item["key"]] = {"type": "array", "items": scalar}
        else:
            properties[item["key"]] = scalar
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
        # 신뢰성·시뮬레이션 분야 보고서가 공통으로 채우는 식별 필드. 어떤
        # 필드든 한 보고서에 여러 항목이 걸릴 수 있어 multi=True로 둠.
        "items": [
            {"key": "model_name", "label": "모델 이름", "type": "text", "multi": True},
            {"key": "part_name", "label": "부품 이름", "type": "text", "multi": True},
            {"key": "bom_code", "label": "BOM Code", "type": "text", "multi": True},
            {"key": "dev_stage", "label": "개발 단계", "type": "text", "multi": True},
            {"key": "defect_type", "label": "불량 종류", "type": "text", "multi": True},
            {"key": "reliability_test", "label": "신뢰성 시험", "type": "text", "multi": True},
            {"key": "simulation_type", "label": "시뮬레이션 종류", "type": "text", "multi": True},
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
    "label": "항목 리스트",
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
            # Image-coordinate annotations (image_pct space — 0..1 across
            # the image's natural width/height). Same shape as chart's.
            "annotations": _ANNOTATIONS_FIELD,
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
            # User-drawn marks over the chart (event lines, period bands,
            # threshold lines, point callouts, etc.). Shape is the shared
            # ANNOTATION_SCHEMA — same field appears on image / milestone.
            "annotations": _ANNOTATIONS_FIELD,
        },
        "additionalProperties": False,
    }


def _flowchart_content(props: dict) -> dict:
    """A flowchart's `items` is an ordered list of steps. The renderer
    connects them in sequence with arrows and prints the label + optional
    description inside each step's box. Targets the "PPT-style process
    diagram" use case — no branching, no per-node shape semantics."""
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "minLength": 1, "maxLength": 200},
                        "description": {"type": "string", "maxLength": 1000},
                    },
                    "required": ["label"],
                    "additionalProperties": False,
                },
            },
        },
        "additionalProperties": False,
    }


FLOWCHART: WidgetDescriptor = {
    "type": "flowchart",
    "label": "순서도",
    "description": "단계별 흐름을 가로 또는 세로로 연결해 표시하는 플로우차트",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            "orientation": {
                "type": "string",
                "enum": ["horizontal", "vertical"],
            },
            "text_style": _TEXT_STYLE_SCHEMA,
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _flowchart_content,
    "default_props": {
        "label": "순서도",
        "orientation": "horizontal",
    },
}


def _milestone_content(props: dict) -> dict:
    """Each item is `{date, label, ?status, ?note}`. The widget plots
    items on a timeline by their `date` value; status drives the marker
    color (pending/done/delayed); note is optional secondary text. The
    schema doesn't enforce ordering — the renderer sorts by date."""
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "date": {"type": "string", "format": "date"},
                        "label": {"type": "string", "minLength": 1, "maxLength": 200},
                        "note": {"type": "string", "maxLength": 500},
                        "status": {
                            "type": "string",
                            "enum": ["pending", "done", "delayed"],
                        },
                    },
                    "required": ["date", "label"],
                    "additionalProperties": False,
                },
            },
            # Timeline annotations — date-coordinate vrange / text on
            # top of the milestone axis. Same shared shape as chart /
            # image annotations.
            "annotations": _ANNOTATIONS_FIELD,
        },
        "additionalProperties": False,
    }


MILESTONE: WidgetDescriptor = {
    "type": "milestone",
    "label": "마일스톤",
    "description": "일정과 항목명으로 타임라인 위에 마커를 표시 (예정/완료/지연 상태)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            # Optional pinned range — when set, the timeline starts/ends
            # at these dates regardless of the data. Useful for quarterly /
            # half-year boards where the X axis should be fixed.
            "start_date": {"type": "string", "format": "date"},
            "end_date": {"type": "string", "format": "date"},
            "text_style": _TEXT_STYLE_SCHEMA,
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _milestone_content,
    "default_props": {"label": "마일스톤"},
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


def _progress_bar_content(props: dict) -> dict:
    """Each item is `{label, value, ?max, ?note}`. The widget renders a
    horizontal bar per item with the fill ratio = value / (max ?? 100).
    Color shades by ratio (red < 30%, amber 30–70%, green ≥ 70%) so the
    writer doesn't need to set status manually — though `status` is left
    available as an explicit override.

    `value` is intentionally permissive (any non-negative number, can
    exceed `max` to show "over goal" cases like 120% delivery)."""
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "minLength": 1, "maxLength": 200},
                        "value": {"type": "number", "minimum": 0},
                        "max": {"type": "number", "exclusiveMinimum": 0},
                        "note": {"type": "string", "maxLength": 500},
                        "status": {
                            "type": "string",
                            "enum": ["pending", "in_progress", "done", "blocked"],
                        },
                    },
                    "required": ["label", "value"],
                    "additionalProperties": False,
                },
            },
        },
        "additionalProperties": False,
    }


# Shared role-item shape — used both at template time (default_roles in
# props) and at report time (content.roles, writer-edited). `group` is
# the optional top-row header label; consecutive roles sharing the same
# group are merged into a single colspan'd top-row cell at render time.
_RACI_ROLE_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "key": {
            "type": "string",
            "pattern": r"^[a-z][a-z0-9_]*$",
            "maxLength": 64,
        },
        "label": {"type": "string", "maxLength": 100},
        "group": {"type": "string", "maxLength": 100},
    },
    "required": ["key"],
    "additionalProperties": False,
}


def _raci_matrix_content(props: dict) -> dict:
    """Each row is `{label, ?note, assignments: { role_key: cell }}`.

    Roles live in `content.roles` (writer-edited) with `props.default_roles`
    as the initial seed. We can't pin assignments keys at schema time
    because the role list is now dynamic per report — the frontend
    enforces consistency by stripping orphaned assignment keys when a
    role column is removed. Cell values stay tightly constrained:
    `/`-joined RACI letters or empty string."""
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "roles": {
                "type": "array",
                "items": _RACI_ROLE_ITEM_SCHEMA,
            },
            "rows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "minLength": 1, "maxLength": 200},
                        "note": {"type": "string", "maxLength": 500},
                        "assignments": {
                            "type": "object",
                            # patternProperties keeps the validation
                            # local to the cell shape without coupling
                            # to a fixed role-key set.
                            "patternProperties": {
                                r"^[a-z][a-z0-9_]{0,63}$": {
                                    "type": "string",
                                    "pattern": r"^([RACI](/[RACI])*)?$",
                                    "maxLength": 7,
                                },
                            },
                            "additionalProperties": False,
                        },
                    },
                    "required": ["label"],
                    "additionalProperties": False,
                },
            },
        },
        "additionalProperties": False,
    }


RACI_MATRIX: WidgetDescriptor = {
    "type": "raci_matrix",
    "label": "RACI 매트릭스",
    "description": "작업(행) × 역할(열) 책임 분담표. 각 셀은 R(실행)/A(책임)/C(자문)/I(통보) 중 하나 또는 슬래시 결합 (예: R/A). 역할 열은 보고서마다 자유롭게 추가·편집 가능, 같은 그룹의 인접 열은 상단 헤더로 자동 병합.",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            # Initial seed roles. Writers can override per-report via
            # `content.roles` (the matrix table's inline header editor).
            "default_roles": {
                "type": "array",
                "items": _RACI_ROLE_ITEM_SCHEMA,
            },
            "text_style": _TEXT_STYLE_SCHEMA,
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _raci_matrix_content,
    "default_props": {
        "label": "RACI 매트릭스",
        # Engineering-flavored default groups. Each entry seeds one
        # column with the work area in the top-row group slot and a
        # blank label slot below — writers fill in the bottom row with
        # individual people, and "역할 추가" appends another column
        # under the most recently used group by default.
        "default_roles": [
            {"key": "modeling", "label": "", "group": "모델링"},
            {"key": "analysis", "label": "", "group": "분석"},
            {"key": "develop", "label": "", "group": "개발"},
            {"key": "design", "label": "", "group": "설계"},
        ],
    },
}


PROGRESS_BAR: WidgetDescriptor = {
    "type": "progress_bar",
    "label": "진행률 바",
    "description": "여러 작업의 진척도를 가로 막대로 한 번에 비교 (값/목표 비율에 따라 색상 자동 매핑)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            # Per-item default target. Most use cases are 0–100% so 100
            # is sensible, but for raw-count progress (e.g. "8 / 12 tasks
            # done") the writer overrides `max` on each item.
            "default_max": {"type": "number", "exclusiveMinimum": 0},
            # Hint suffix appended to the value/max display ("%", "건",
            # "h", ...). Purely cosmetic — value math is unit-agnostic.
            "unit": {"type": "string", "maxLength": 8},
            "min_items": {"type": "integer", "minimum": 0},
            "max_items": {"type": "integer", "minimum": 1},
            "text_style": _TEXT_STYLE_SCHEMA,
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _progress_bar_content,
    "default_props": {
        "label": "진행률",
        "default_max": 100,
        "unit": "%",
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
        IMAGE,
        ATTACHMENT,
        CHART,
        MILESTONE,
        FLOWCHART,
        PROGRESS_BAR,
        RACI_MATRIX,
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
