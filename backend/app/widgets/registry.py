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
            # Extra vertical space below the heading, in pixels. Lets
            # the designer push the next block away from a section
            # heading without dropping in a spacer widget. 0 keeps the
            # widget's grid-cell flush against the next row.
            "margin_bottom_px": {
                "type": "integer",
                "minimum": 0,
                "maximum": 200,
            },
        },
        "required": ["level"],
        "additionalProperties": False,
    },
    "content_schema_for": lambda props: {
        "type": "object",
        "properties": {
            "text": {"type": "string", "maxLength": 200},
            # Per-report overrides — let the writer tune heading level,
            # text style, and bottom spacing from the inline popover
            # without touching the template. Renderer reads
            # `content.<field> ?? props.<field> ?? default`.
            "level": {"type": "integer", "enum": [1, 2, 3]},
            "text_style": _TEXT_STYLE_SCHEMA,
            "margin_bottom_px": {
                "type": "integer",
                "minimum": 0,
                "maximum": 200,
            },
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
# 3. key_value — 라벨–값 쌍 (자유 입력)                                        #
#                                                                              #
# 이 위젯은 보고서 작성자가 자유롭게 key/label/type을 정의해 값을 넣는           #
# 범용 메모/메타 위젯이다. 템플릿 디자이너가 미리 필드를 정해놓지 않는 게         #
# 기본이고, 필요하면 props.items로 초깃값을 줄 수도 있다. 보고서별 필드          #
# 정의는 content.items로 들어가며, 이때 props.items는 무시된다.                  #
# --------------------------------------------------------------------------- #
def _key_value_content(props: dict) -> dict:  # noqa: ARG001
    # Items 정의가 content로 옮겨갈 수 있어 키 셋이 동적이다 — patternProperties
    # 로 슬러그 키만 받고 값은 프리미티브 또는 프리미티브 배열만 허용한다.
    # 정밀한 타입 검증(예: number 항목에 문자열 금지)은 프론트엔드가 입력
    # 단계에서 강제하고, 백엔드는 형식의 큰 골격만 본다.
    primitive_or_array = {
        "anyOf": [
            {"type": ["string", "number", "boolean", "null"]},
            {
                "type": "array",
                "items": {"type": ["string", "number", "boolean", "null"]},
            },
        ],
    }
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            # 보고서별 필드 정의 — 비어 있으면 props.items로 폴백.
            "items": {
                "type": "array",
                "items": _FIELD_ITEM_PROPS_SCHEMA,
            },
        },
        # patternProperties applies to ALL keys matching the regex,
        # including those listed in `properties` above. We exclude the
        # reserved names via negative lookahead so the items/caption
        # entries don't get clobbered by the value-shape constraint.
        "patternProperties": {
            r"^(?!(caption|caption_skip_autofill|items)$)[a-z][a-z0-9_]{0,63}$": primitive_or_array,
        },
        "additionalProperties": False,
    }


KEY_VALUE: WidgetDescriptor = {
    "type": "key_value",
    "label": "키-값",
    "description": "자유로운 key-value 쌍을 보고서마다 직접 정의해 입력 — 메모, 사양표, 메타정보 등에 사용",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "maxLength": 200},
            # 템플릿 차원에서 초깃값을 미리 넣고 싶을 때만 사용. 보고서마다
            # 자유롭게 추가/삭제할 수 있는 위젯이므로 기본은 비어 있다.
            "items": {
                "type": "array",
                "items": _FIELD_ITEM_PROPS_SCHEMA,
            },
            "text_style": _TEXT_STYLE_SCHEMA,
        },
        # items 필수 아님 — 보고서 작성자가 직접 정의하는 것이 기본 흐름.
        "additionalProperties": False,
    },
    "content_schema_for": _key_value_content,
    "default_props": {
        "label": "메모",
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
            # Per-report layout overrides — tunable from the 위젯 편집
            # toolbar. `max_count` is a soft UI cap (hard cap stays in
            # the files maxItems below). `aspect_ratio` overrides the
            # template's preview ratio for this report.
            "max_count": {"type": "integer", "minimum": 1, "maximum": 50},
            "aspect_ratio": {
                "type": "string",
                "pattern": r"^\d+:\d+$",
                "description": "예: '16:9', '4:3', '1:1'",
            },
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
            # Per-report soft cap on file count. The hard cap stays in
            # props.max_count (used for the JSON Schema `maxItems`);
            # content.max_count narrows the UI quota further so the
            # writer can declare "this report wants only 2 files" even
            # if the template allows 10.
            "max_count": {"type": "integer", "minimum": 1, "maximum": 50},
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
# 8a. video — playable video file(s) (mp4 / webm / etc.)                       #
# --------------------------------------------------------------------------- #
# Same `file_id` storage model as image/attachment — the frontend
# fetches the bytes via the auth'd files API, wraps them in a blob URL,
# and feeds that to a native <video controls> element. AI never fills
# this (no file_id), so it joins the "do not generate" prompt group.
def _video_content(props: dict) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            # Per-report playback overrides — same fields as the
            # matching props_schema entries. `max_count` is a soft UI
            # cap (hard cap stays in the files maxItems below).
            "max_count": {"type": "integer", "minimum": 1, "maximum": 10},
            "autoplay": {"type": "boolean"},
            "loop": {"type": "boolean"},
            "muted": {"type": "boolean"},
            "files": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "file_id": {"type": "string", "minLength": 1},
                        "filename": {"type": "string", "minLength": 1, "maxLength": 255},
                        "size": {"type": "integer", "minimum": 0},
                        "mime_type": {"type": "string", "maxLength": 100},
                    },
                    "required": ["file_id"],
                    "additionalProperties": False,
                },
                "minItems": 0,
                "maxItems": props.get("max_count", 4),
            },
        },
        "additionalProperties": False,
    }


VIDEO: WidgetDescriptor = {
    "type": "video",
    "label": "동영상",
    "description": "업로드한 동영상 파일을 웹에서 재생 (mp4 / webm / mov / ogg / m4v)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            "max_count": {"type": "integer", "minimum": 1, "maximum": 10},
            # Playback defaults — author overrides per-instance via the
            # editor; the report viewer sees these exact options unless
            # the user changes the player controls at runtime.
            "autoplay": {"type": "boolean"},
            "loop": {"type": "boolean"},
            "muted": {"type": "boolean"},
        },
        "required": ["label", "max_count"],
        "additionalProperties": False,
    },
    "content_schema_for": _video_content,
    "default_props": {"label": "동영상", "max_count": 1},
}


# --------------------------------------------------------------------------- #
# 8b. html_embed — uploaded HTML rendered in-place via sandboxed iframe       #
# --------------------------------------------------------------------------- #
# Pattern mirrors `attachment`: the report stores a single `file_id` from
# /api/files, and the frontend loads it into an iframe with sandbox so the
# author's HTML (potentially including <script>, <style>, external <img>)
# renders verbatim without leaking into the report shell. AI never fills
# this — like image / attachment / cad_3d, it requires a real file_id.
def _html_embed_content(props: dict) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            "file_id": {"type": "string", "minLength": 1},
            # Display only — the original uploaded filename so the editor
            # can show "report.html" next to the upload button.
            "filename": {"type": "string", "maxLength": 255},
            # Optional explicit pixel height for the iframe cell. Useful
            # for HTML that can't reliably postMessage its own height
            # (cross-origin assets, async-rendered content). When unset
            # the widget falls back to its grid cell height.
            "height_px": {"type": "integer", "minimum": 60, "maximum": 4000},
        },
        # file_id is *not* required at the schema level so a freshly-
        # inserted widget with no upload yet still validates — the
        # frontend handles the "empty" UX inline.
        "additionalProperties": False,
    }


HTML_EMBED: WidgetDescriptor = {
    "type": "html_embed",
    "label": "HTML 임베드",
    "description": "업로드한 HTML 파일을 sandbox iframe 으로 그대로 렌더 (스크립트 OK, 메인 페이지와 격리)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _html_embed_content,
    "default_props": {"label": "HTML"},
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
        # Empty labels are intentionally allowed — auto-added columns
        # (via paste / "열 추가") start blank and the editor uses the
        # column key as a visual placeholder until the user names them.
        # Rejecting "" here makes "add column → save" fail with a
        # cryptic validation error.
        "label": {"type": "string", "maxLength": 200},
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
            # Optional axis range overrides. When unset, Recharts picks
            # the domain from the data. Numeric x-axis (rare — most x
            # axes are categorical) honors x_min/x_max; categorical x
            # ignores them. y_min/y_max always apply.
            "x_min": {"type": "number"},
            "x_max": {"type": "number"},
            "y_min": {"type": "number"},
            "y_max": {"type": "number"},
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
            # Per-report orientation override — renderer reads
            # `content.orientation ?? props.orientation ?? 'horizontal'`.
            "orientation": {
                "type": "string",
                "enum": ["horizontal", "vertical"],
            },
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
            # Per-report timeline range overrides — same fields as
            # `props.start_date / end_date` but tunable from the
            # 위젯 편집 toolbar without touching the template.
            "start_date": {"type": "string", "format": "date"},
            "end_date": {"type": "string", "format": "date"},
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
    "label": "막대/선 차트",
    "description": "범주형 x축 (분기, 모델명 등) + 막대 / 꺾은선 — 사양·결과 비교용",
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
# 9b. scatter — XY scatter / line chart over numeric coordinates
# --------------------------------------------------------------------------- #
# Distinct from CHART above (which has a CATEGORICAL x-axis for spec
# comparison). Scatter assumes BOTH x and y are numeric — useful for
# measurement plots, calibration curves, parametric data, etc.
_SCATTER_MODES = ("scatter", "line", "scatter_line")

# Scatter columns are number-only — no categorical x. Same shape as
# _CHART_COLUMN_SCHEMA but with the type enum locked to "number".
_SCATTER_COLUMN_SCHEMA = {
    "type": "object",
    "properties": {
        "key": {"type": "string", "pattern": r"^[a-z][a-z0-9_]*$", "maxLength": 64},
        # Empty labels allowed — matches _CHART_COLUMN_SCHEMA, lets
        # paste-extended / "열 추가" columns survive until the user
        # names them.
        "label": {"type": "string", "maxLength": 200},
        "type": {"type": "string", "enum": ["number"]},
        "meta": {"type": "object"},
    },
    "required": ["key", "label", "type"],
    "additionalProperties": False,
}


def _scatter_content(props: dict) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "mode": {"type": "string", "enum": list(_SCATTER_MODES)},
            # Legacy "shared x" key — when `series` is absent, the
            # frontend derives series from this + any number column
            # that isn't the X column. New saves write explicit
            # series instead.
            "x_column_key": {"type": "string", "pattern": r"^[a-z][a-z0-9_]*$"},
            # Explicit (x, y) pair series. Each entry picks two columns
            # from `columns` — different series can share an x column
            # or have entirely independent x columns. When present,
            # this REPLACES the legacy shared-x derivation.
            "series": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "maxLength": 200},
                        "x_key": {
                            "type": "string",
                            "pattern": r"^[a-z][a-z0-9_]*$",
                            "maxLength": 64,
                        },
                        "y_key": {
                            "type": "string",
                            "pattern": r"^[a-z][a-z0-9_]*$",
                            "maxLength": 64,
                        },
                        "color": {"type": "string", "maxLength": 64},
                    },
                    "required": ["x_key", "y_key"],
                    "additionalProperties": False,
                },
            },
            "x_axis_title": {"type": "string", "maxLength": 100},
            "y_axis_title": {"type": "string", "maxLength": 100},
            "x_min": {"type": "number"},
            "x_max": {"type": "number"},
            "y_min": {"type": "number"},
            "y_max": {"type": "number"},
            "columns": {
                "type": "array",
                "items": _SCATTER_COLUMN_SCHEMA,
            },
            "rows": {
                "type": "array",
                "items": {"type": "object", "additionalProperties": True},
            },
            # Same annotation shape the chart uses; works because the
            # scatter axes are also `data` coord-space.
            "annotations": _ANNOTATIONS_FIELD,
        },
        "additionalProperties": False,
    }


SCATTER: WidgetDescriptor = {
    "type": "scatter",
    "label": "산점도",
    "description": "x·y 모두 수치인 좌표 그래프 — 산점도 / 곡선 / 둘 다",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            "mode": {"type": "string", "enum": list(_SCATTER_MODES)},
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
                "items": _SCATTER_COLUMN_SCHEMA,
            },
        },
        "required": ["label", "mode", "x_column_key", "columns"],
        "additionalProperties": False,
    },
    "content_schema_for": _scatter_content,
    "default_props": {
        "label": "산점도",
        "mode": "scatter_line",
        "x_column_key": "x",
        "columns": [
            {"key": "x", "label": "X", "type": "number"},
            {"key": "y", "label": "Y", "type": "number"},
        ],
    },
}


# --------------------------------------------------------------------------- #
# 9c. scatter3d — 3D XY-Z scatter plot (Plotly-backed)
# --------------------------------------------------------------------------- #
# Each series picks three columns from the data — (x, y, z) — and is
# plotted as a marker cloud. Rotation / zoom / hover come for free via
# Plotly's scene controls. Annotations are intentionally OUT OF SCOPE
# here — the user's reference axis space rotates with the camera, so
# 2-D-pixel annotation primitives don't map cleanly onto 3-D points.
_SCATTER3D_MODES = ("scatter3d",)
# Series render kind. Both kinds consume the same (x, y, z) long-form
# columns — `surface` pivots them into a grid at render time. Mixing
# kinds in one widget is allowed (e.g. measured points + fitted
# response surface in the same plot).
_SCATTER3D_SERIES_KINDS = ("scatter3d", "surface")
# Curated colorscale names Plotly accepts natively. Used widget-wide
# (one colorbar per chart) rather than per-series — keeps the
# legend / colorbar uncluttered when multiple series share a color
# axis. Mix of perceptual (Viridis / Plasma / Cividis), sequential
# (Blues / Reds / Hot), diverging (RdBu / Bluered), and legacy
# rainbow (Jet) — covers most engineering report needs.
_SCATTER3D_COLORSCALES = (
    "Viridis",
    "Plasma",
    "Cividis",
    "Hot",
    "Blues",
    "Reds",
    "Greens",
    "RdBu",
    "Bluered",
    "Portland",
    "Jet",
)


def _scatter3d_content(props: dict) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "mode": {"type": "string", "enum": list(_SCATTER3D_MODES)},
            # Color ramp applied to every series that uses an
            # independent color axis. Single chart-wide value because
            # mixing ramps in one scene is visually confusing.
            "colorscale": {
                "type": "string",
                "enum": list(_SCATTER3D_COLORSCALES),
            },
            "series": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "maxLength": 200},
                        "kind": {
                            "type": "string",
                            "enum": list(_SCATTER3D_SERIES_KINDS),
                        },
                        "x_key": {
                            "type": "string",
                            "pattern": r"^[a-z][a-z0-9_]*$",
                            "maxLength": 64,
                        },
                        "y_key": {
                            "type": "string",
                            "pattern": r"^[a-z][a-z0-9_]*$",
                            "maxLength": 64,
                        },
                        "z_key": {
                            "type": "string",
                            "pattern": r"^[a-z][a-z0-9_]*$",
                            "maxLength": 64,
                        },
                        # Optional 4th coordinate — when set, scatter
                        # markers are colored by this column and
                        # surfaces paint a contour-style colormap
                        # using it as `surfacecolor` (independent
                        # of z). Same column-key pattern as the
                        # geometric axes.
                        "color_key": {
                            "type": "string",
                            "pattern": r"^[a-z][a-z0-9_]*$",
                            "maxLength": 64,
                        },
                        "color": {"type": "string", "maxLength": 64},
                    },
                    "required": ["x_key", "y_key", "z_key"],
                    "additionalProperties": False,
                },
            },
            "x_axis_title": {"type": "string", "maxLength": 100},
            "y_axis_title": {"type": "string", "maxLength": 100},
            "z_axis_title": {"type": "string", "maxLength": 100},
            "columns": {
                "type": "array",
                "items": _SCATTER_COLUMN_SCHEMA,
            },
            "rows": {
                "type": "array",
                "items": {"type": "object", "additionalProperties": True},
            },
            # NO `annotations` field — 3D rotation makes 2-D-pixel
            # annotation geometry meaningless. Re-enable when / if a
            # 3-D-aware annotation system lands.
        },
        "additionalProperties": False,
    }


SCATTER3D: WidgetDescriptor = {
    "type": "scatter3d",
    "label": "3D 산점도",
    "description": "x·y·z 3축 수치 좌표 — 회전 / 확대 / 호버 가능 (Plotly)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            "x_axis_title": {"type": "string", "maxLength": 100},
            "y_axis_title": {"type": "string", "maxLength": 100},
            "z_axis_title": {"type": "string", "maxLength": 100},
            "columns": {
                "type": "array",
                "minItems": 3,
                "items": _SCATTER_COLUMN_SCHEMA,
            },
        },
        "required": ["label", "columns"],
        "additionalProperties": False,
    },
    "content_schema_for": _scatter3d_content,
    "default_props": {
        "label": "3D 산점도",
        "columns": [
            {"key": "x", "label": "X", "type": "number"},
            {"key": "y", "label": "Y", "type": "number"},
            {"key": "z", "label": "Z", "type": "number"},
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
            # Per-report defaults — overrideable in the 위젯 편집 toolbar.
            # Same shape as the matching props_schema fields.
            "default_max": {"type": "number", "exclusiveMinimum": 0},
            "unit": {"type": "string", "maxLength": 8},
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


# --------------------------------------------------------------------------- #
# 9d. heatmap — 2D color matrix (correlation, parameter sweep, etc.)
# --------------------------------------------------------------------------- #
# Data shape is intentionally NOT the columns+rows model the scatter
# widgets use. A heatmap is a 2-D matrix indexed by (row, col) — the
# row / col labels are positional, not keyed — so we store
# `x_labels[]`, `y_labels[]`, and a `matrix[row][col]` of numbers.
# Cells may be null for sparse data (Plotly draws those as gaps).
_HEATMAP_COLORSCALES = (
    "Viridis",
    "Plasma",
    "Cividis",
    "Hot",
    "Blues",
    "Reds",
    "Greens",
    "RdBu",
    "Bluered",
    "Portland",
    "Jet",
)


def _heatmap_content(props: dict) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            # Positional labels — length must match the matrix shape.
            # Frontend keeps them in sync on edit; backend only checks
            # that they're strings of sane length.
            "x_labels": {
                "type": "array",
                "items": {"type": "string", "maxLength": 200},
            },
            "y_labels": {
                "type": "array",
                "items": {"type": "string", "maxLength": 200},
            },
            "matrix": {
                "type": "array",
                "items": {
                    "type": "array",
                    "items": {"type": ["number", "null"]},
                },
            },
            "colorscale": {
                "type": "string",
                "enum": list(_HEATMAP_COLORSCALES),
            },
            "reverse_scale": {"type": "boolean"},
            # Optional fixed color domain. When unset Plotly auto-fits
            # to the data range — usually right, but explicit bounds
            # matter when comparing multiple heatmaps in one report.
            "z_min": {"type": "number"},
            "z_max": {"type": "number"},
            "x_axis_title": {"type": "string", "maxLength": 100},
            "y_axis_title": {"type": "string", "maxLength": 100},
            "show_values": {"type": "boolean"},
        },
        "additionalProperties": False,
    }


HEATMAP: WidgetDescriptor = {
    "type": "heatmap",
    "label": "히트맵",
    "description": "2D 값 매트릭스를 색상으로 — 상관행렬, 파라미터 스윕, 민감도 등",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            "x_axis_title": {"type": "string", "maxLength": 100},
            "y_axis_title": {"type": "string", "maxLength": 100},
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _heatmap_content,
    "default_props": {
        "label": "히트맵",
    },
}


# --------------------------------------------------------------------------- #
# 11b. contour — 2D contour plot (Plotly type:'contour')                      #
# --------------------------------------------------------------------------- #
# Data shape mirrors heatmap (`x_labels` / `y_labels` / `matrix`) so authors
# don't relearn a grid layout — what differs is the rendering: instead of
# coloring each cell, Plotly draws iso-value curves over the field. The
# extra knobs control how those curves look (count, line vs. filled, label).
_CONTOUR_COLORING_MODES = ("fill", "heatmap", "lines", "none")


_CONTOUR_INPUT_MODES = ("matrix", "rows")


def _contour_content(props: dict) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            # Which input model the user is editing in.  Defaults to
            # 'matrix' for backward compatibility (existing reports
            # don't carry this field).
            #   'matrix' — x_labels / y_labels / matrix[row][col]
            #   'rows'   — long-form list of {x, y, z} numeric points.
            #              Renderer normalizes into the matrix form by
            #              taking the union of unique x's and y's as
            #              axes; cells without a matching row stay null.
            "mode": {
                "type": "string",
                "enum": list(_CONTOUR_INPUT_MODES),
            },
            # matrix-mode data ──────────────────────────────────────
            "x_labels": {
                "type": "array",
                "items": {"type": "string", "maxLength": 200},
            },
            "y_labels": {
                "type": "array",
                "items": {"type": "string", "maxLength": 200},
            },
            "matrix": {
                "type": "array",
                "items": {
                    "type": "array",
                    "items": {"type": ["number", "null"]},
                },
            },
            # rows-mode data ─────────────────────────────────────────
            # Each entry is a single (x, y, z) sample. All three must
            # be numeric; rows missing any of them are skipped at
            # render time (the frontend keeps them in the table so the
            # author can fill them in later).
            "rows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "x": {"type": ["number", "null"]},
                        "y": {"type": ["number", "null"]},
                        "z": {"type": ["number", "null"]},
                    },
                    "additionalProperties": False,
                },
            },
            "colorscale": {
                "type": "string",
                "enum": list(_HEATMAP_COLORSCALES),
            },
            "reverse_scale": {"type": "boolean"},
            # Fixed value-domain — same usage as heatmap's z_min/z_max
            # (locking the color range when comparing multiple plots).
            "z_min": {"type": "number"},
            "z_max": {"type": "number"},
            "x_axis_title": {"type": "string", "maxLength": 100},
            "y_axis_title": {"type": "string", "maxLength": 100},
            # contour-specific knobs ─────────────────────────────────
            # Number of contour levels Plotly auto-picks between
            # min/max. Plotly uses 15 by default.
            "ncontours": {"type": "integer", "minimum": 2, "maximum": 100},
            # `fill` = filled bands + lines (default).
            # `heatmap` = filled like a heatmap, no contour lines.
            # `lines` = lines only, transparent background.
            # `none` = same as fill but explicit (kept for completeness).
            "contours_coloring": {
                "type": "string",
                "enum": list(_CONTOUR_COLORING_MODES),
            },
            "show_lines": {"type": "boolean"},
            # Numeric labels printed on each contour line.
            "show_labels": {"type": "boolean"},
            # Bridge null / sparse cells by carrying neighbor values
            # across the gap. Plotly's `contour.connectgaps` — turns a
            # ragged data field (DOE results, partial measurements) into
            # a continuous contour map instead of a checkerboard of
            # voids. Default true at render time so authors don't have
            # to think about it; explicit false opts back into "strict
            # nulls" for cases where the gaps mean something.
            "connect_gaps": {"type": "boolean"},
        },
        "additionalProperties": False,
    }


CONTOUR: WidgetDescriptor = {
    "type": "contour",
    "label": "등고선 차트",
    "description": "2D 값 매트릭스를 등고선으로 — 응답면, 등압선, 민감도 등고",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            "x_axis_title": {"type": "string", "maxLength": 100},
            "y_axis_title": {"type": "string", "maxLength": 100},
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _contour_content,
    "default_props": {
        "label": "등고선",
    },
}


# --------------------------------------------------------------------------- #
# 11c. treemap — hierarchical area chart (Plotly type:'treemap')              #
# --------------------------------------------------------------------------- #
# Data model is a flat long-form list of `{label, parent, value}` rows so the
# editor can stay a simple 3-column table — Plotly internally rebuilds the
# tree from `parents[i]` pointing back into another row's `label` (root rows
# use `""`). This avoids forcing the user to think in terms of nested JSON.
#
# `text_info` mirrors Plotly's `textinfo` flag (which substrings appear on
# each box). `branchvalues` decides whether a parent's value is independent
# (=`total`) or the sum of its leaves (=`remainder`); we default to
# `remainder` so the AI / author can leave parents blank and have Plotly
# compute the rollup automatically.
_TREEMAP_TEXT_INFO = (
    "label",
    "label+value",
    "label+value+percent_parent",
    "label+value+percent_root",
    "label+percent_root",
    "value",
    "none",
)
_TREEMAP_BRANCH_VALUES = ("remainder", "total")


def _treemap_content(props: dict) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            # Unit string appended to numeric values in the cell labels
            # + hover (e.g. "억원", "%", "건"). Free-form so the author
            # can type the punctuation/spacing they want.
            "unit": {"type": "string", "maxLength": 32},
            # Flat list of nodes. `parent` is another row's `label`, or
            # an empty string for top-level nodes. `value` is required at
            # leaf level — Plotly fills parents in via `branchvalues` =
            # 'remainder'. We keep them nullable so the editor can hold
            # half-typed rows without failing schema validation.
            "rows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "maxLength": 200},
                        "parent": {"type": "string", "maxLength": 200},
                        "value": {"type": ["number", "null"]},
                        # Optional explicit fill color (CSS / hex string).
                        # When unset Plotly picks from the categorical
                        # palette or maps from the colorscale below.
                        "color": {"type": "string", "maxLength": 32},
                    },
                    "additionalProperties": False,
                },
            },
            # Optional value-driven colorscale. When set Plotly maps each
            # node's value through the scale instead of using categorical
            # colors — useful for "size + intensity" encodings.
            "colorscale": {
                "type": "string",
                "enum": list(_HEATMAP_COLORSCALES),
            },
            "reverse_scale": {"type": "boolean"},
            "text_info": {
                "type": "string",
                "enum": list(_TREEMAP_TEXT_INFO),
            },
            "branchvalues": {
                "type": "string",
                "enum": list(_TREEMAP_BRANCH_VALUES),
            },
        },
        "additionalProperties": False,
    }


# --------------------------------------------------------------------------- #
# 11d. pie / donut — flat proportion chart (Plotly type:'pie')                #
# --------------------------------------------------------------------------- #
# Single trace covers both pie and donut — `chart_type: 'donut'` just
# sets a non-zero hole. Data is a flat list of `{label, value, color?}`
# rows; no parent/children, no hierarchy. For hierarchical proportions
# use treemap instead.
_PIE_CHART_TYPES = ("pie", "donut")
_PIE_TEXT_INFO = (
    "label",
    "label+percent",
    "label+value",
    "label+value+percent",
    "percent",
    "value",
    "none",
)
_PIE_TEXT_POSITIONS = ("auto", "inside", "outside", "none")


def _pie_content(props: dict) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            "unit": {"type": "string", "maxLength": 32},
            "rows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "maxLength": 200},
                        "value": {"type": ["number", "null"]},
                        "color": {"type": "string", "maxLength": 32},
                    },
                    "additionalProperties": False,
                },
            },
            "chart_type": {
                "type": "string",
                "enum": list(_PIE_CHART_TYPES),
            },
            # Donut center hole as a ratio of the chart radius (0..0.9).
            # Only consulted when `chart_type == 'donut'`; default 0.45
            # which gives a recognisable donut without the slices feeling
            # too thin.
            "hole": {"type": "number", "minimum": 0, "maximum": 0.9},
            "colorscale": {
                "type": "string",
                "enum": list(_HEATMAP_COLORSCALES),
            },
            "reverse_scale": {"type": "boolean"},
            "text_info": {
                "type": "string",
                "enum": list(_PIE_TEXT_INFO),
            },
            "text_position": {
                "type": "string",
                "enum": list(_PIE_TEXT_POSITIONS),
            },
            # Plotly default is true (largest first). Disable for cases
            # where the row order itself carries meaning (e.g. process
            # stage, calendar order).
            "sort": {"type": "boolean"},
            "show_legend": {"type": "boolean"},
        },
        "additionalProperties": False,
    }


# --------------------------------------------------------------------------- #
# 11f. boxplot — long-form box-and-whisker chart (Plotly type:'box')          #
# --------------------------------------------------------------------------- #
# Data is a flat `rows: [{group, value}]` list — each row is one
# observation; rows sharing the same `group` form a single box. Plotly
# computes quartiles / median / whiskers / outliers from the raw values
# automatically, so authors never need to precompute summary stats.
_BOX_ORIENTATION = ("vertical", "horizontal")
_BOX_POINTS = ("outliers", "suspectedoutliers", "all", "none")
_BOX_MEAN = ("none", "line", "sd")


def _box_content(props: dict) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            "unit": {"type": "string", "maxLength": 32},
            "x_axis_title": {"type": "string", "maxLength": 100},
            "y_axis_title": {"type": "string", "maxLength": 100},
            "rows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "group": {"type": "string", "maxLength": 200},
                        "value": {"type": ["number", "null"]},
                    },
                    "additionalProperties": False,
                },
            },
            "orientation": {
                "type": "string",
                "enum": list(_BOX_ORIENTATION),
            },
            # Value-axis manual range. Applied to Plotly's yaxis.range
            # when orientation='vertical' (default) and xaxis.range when
            # 'horizontal'. Either bound can be null — a one-sided
            # clamp is interpreted client-side as "auto on that side,
            # fixed on this one".
            "y_min": {"type": ["number", "null"]},
            "y_max": {"type": ["number", "null"]},
            # outliers: classical (default). suspectedoutliers: 3·IQR
            # marker tint. all: every data point shown alongside the
            # box. none: clean box without dots.
            "box_points": {
                "type": "string",
                "enum": list(_BOX_POINTS),
            },
            # `line`: dashed line at the mean. `sd`: line + a vertical
            # ±1σ marker. `none`: median only (Plotly default).
            "box_mean": {
                "type": "string",
                "enum": list(_BOX_MEAN),
            },
            # How spread out the individual point dots are. 0 = stacked
            # on the box axis, 1 = full sibling-box width. Only matters
            # when box_points != 'none'.
            "jitter": {"type": "number", "minimum": 0, "maximum": 1},
        },
        "additionalProperties": False,
    }


BOX: WidgetDescriptor = {
    "type": "box",
    "label": "박스플롯",
    "description": "그룹별 분포 (5수치 요약 + 이상치) — A/B 비교, 실험 분산, 측정값 산포",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            "x_axis_title": {"type": "string", "maxLength": 100},
            "y_axis_title": {"type": "string", "maxLength": 100},
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _box_content,
    "default_props": {
        "label": "박스플롯",
    },
}


# --------------------------------------------------------------------------- #
# 11f-2. density — overlaid 1D KDE curves for group/time comparison           #
# --------------------------------------------------------------------------- #
# Each group is a flat array of measurements; the frontend computes a
# Gaussian KDE per group and overlays the curves on a shared x-axis so
# distribution shape, mode shift, and spread can be compared at a
# glance. Optional rug / jittered dots surface the raw observations
# underneath the curves.
_DENSITY_DOT_MODES = ("none", "rug", "jitter")
_DENSITY_BANDWIDTH_MODES = ("auto", "manual")


def _density_content(props: dict) -> dict:  # noqa: ARG001
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            "unit": {"type": "string", "maxLength": 32},
            "x_axis_title": {"type": "string", "maxLength": 100},
            "y_axis_title": {"type": "string", "maxLength": 100},
            # Group-wise raw values. The KDE is computed client-side
            # from these — keeping raw input lets the writer toggle
            # bandwidth / dots without losing data fidelity.
            "groups": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "maxLength": 200},
                        "color": {"type": "string", "maxLength": 64},
                        "values": {
                            "type": "array",
                            "items": {"type": ["number", "null"]},
                        },
                    },
                    "required": ["name", "values"],
                    "additionalProperties": False,
                },
            },
            # 'auto' uses Silverman's rule client-side; 'manual' honors
            # `bandwidth` literally so writers can sharpen / smooth.
            "bandwidth_mode": {
                "type": "string",
                "enum": list(_DENSITY_BANDWIDTH_MODES),
            },
            "bandwidth": {"type": "number", "exclusiveMinimum": 0},
            # Sample count for the curve polyline. Higher = smoother
            # but more SVG nodes; 128–512 is the sweet spot.
            "samples": {"type": "integer", "minimum": 16, "maximum": 1024},
            # Manual x-range. Either side null = auto on that side.
            "x_min": {"type": ["number", "null"]},
            "x_max": {"type": ["number", "null"]},
            # Fill under each curve at low opacity for emphasis.
            "fill": {"type": "boolean"},
            # 'rug' = short ticks on the baseline. 'jitter' = scattered
            # dots just under the baseline. 'none' hides raw data.
            "show_dots": {
                "type": "string",
                "enum": list(_DENSITY_DOT_MODES),
            },
            "dot_opacity": {"type": "number", "minimum": 0, "maximum": 1},
        },
        "additionalProperties": False,
    }


DENSITY: WidgetDescriptor = {
    "type": "density",
    "label": "밀도 곡선",
    "description": "그룹별 1D KDE 곡선 — 시간·그룹별 분포 비교, 옵션으로 원데이터 점 표기",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            "x_axis_title": {"type": "string", "maxLength": 100},
            "y_axis_title": {"type": "string", "maxLength": 100},
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _density_content,
    "default_props": {
        "label": "밀도 곡선",
    },
}


# --------------------------------------------------------------------------- #
# 11g. waffle — grid-of-cells proportion chart                                 #
# --------------------------------------------------------------------------- #
# Each cell is one slice of the whole (default 1% of the total). Cells
# are colored by group and laid out in a `cols × rows` grid (default
# 10×10). Visually it reads as a pie chart that's been "unrolled" into
# a percentage grid — easier to compare small shares than a pie because
# every 1% is the same shape, and it prints / exports cleanly.
_WAFFLE_SHAPES = ("square", "circle")
_WAFFLE_DIRECTIONS = ("row", "column")


def _waffle_content(props: dict) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            "unit": {"type": "string", "maxLength": 32},
            "rows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "maxLength": 200},
                        "value": {"type": ["number", "null"]},
                        "color": {"type": "string", "maxLength": 32},
                    },
                    "additionalProperties": False,
                },
            },
            # Grid dimensions. cols × rows = total cells. Common
            # choices: 10×10 (100 cells, 1%/cell), 5×5 (25 cells, 4%),
            # 20×5 (100 cells, slim shape). Keep both at a sane
            # bound so authors can't accidentally request 10 000 cells.
            "cols": {"type": "integer", "minimum": 1, "maximum": 50},
            "grid_rows": {"type": "integer", "minimum": 1, "maximum": 50},
            "shape": {"type": "string", "enum": list(_WAFFLE_SHAPES)},
            # Direction in which cells are filled. 'column' (bottom-up,
            # left-to-right) is the convention most waffle / pictogram
            # charts use because it reads like a bar piling up. 'row'
            # fills left-to-right, top-to-bottom (text-style).
            "fill_direction": {
                "type": "string",
                "enum": list(_WAFFLE_DIRECTIONS),
            },
            "show_legend": {"type": "boolean"},
            # When set, every cell shows the share of the total it
            # represents in the hover/legend; cells themselves stay
            # plain. Mostly for documenting "1 cell = N units".
            "show_value_per_cell": {"type": "boolean"},
        },
        "additionalProperties": False,
    }


WAFFLE: WidgetDescriptor = {
    "type": "waffle",
    "label": "와플 차트",
    "description": "비율을 격자 100칸 (또는 N칸) 으로 — 점유율·달성률·인구 비중 등 (파이 대안, 작은 % 비교에 강함)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _waffle_content,
    "default_props": {
        "label": "비중",
    },
}


PIE: WidgetDescriptor = {
    "type": "pie",
    "label": "파이 / 도넛 차트",
    "description": "비중을 한 원의 부채꼴로 — 항목별 점유, 비용 구성 등 (계층은 트리맵)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _pie_content,
    "default_props": {
        "label": "비중",
    },
}


# --------------------------------------------------------------------------- #
# 11e. packing — circle packing (d3-hierarchy pack layout)                     #
# --------------------------------------------------------------------------- #
# Same long-form `rows: [{label, parent, value, color}]` model the
# treemap uses — they share data shape but render very differently
# (treemap = squarified rectangles, packing = nested circles). Plotly
# has no built-in trace for circle packing, so this one renders with
# d3-hierarchy's pack layout into a plain SVG inside the widget.
def _packing_content(props: dict) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            "unit": {"type": "string", "maxLength": 32},
            "rows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "maxLength": 200},
                        "parent": {"type": "string", "maxLength": 200},
                        "value": {"type": ["number", "null"]},
                        "color": {"type": "string", "maxLength": 32},
                    },
                    "additionalProperties": False,
                },
            },
            "colorscale": {
                "type": "string",
                "enum": list(_HEATMAP_COLORSCALES),
            },
            "reverse_scale": {"type": "boolean"},
            # 'label' / 'label+value' / 'label+value+percent' / 'value' /
            # 'none'. Percentage is relative to the immediate parent
            # (same semantics as treemap's percent_parent). NB: jsonschema
            # wants the enum as a **list** — tuples here look the same in
            # Python but the validator's internal serialization rejects
            # them, surfacing as a 500 instead of a clean ValueError when
            # a report tries to save.
            "text_info": {
                "type": "string",
                "enum": [
                    "label",
                    "label+value",
                    "label+value+percent",
                    "value",
                    "none",
                ],
            },
            # Pixel padding between sibling circles inside the same
            # parent. Bigger values make the grouping more obvious at
            # the cost of usable area for the actual leaves.
            "padding": {"type": "integer", "minimum": 0, "maximum": 20},
        },
        "additionalProperties": False,
    }


# --------------------------------------------------------------------------- #
# 11h. tree — node-and-edge tree diagram (d3-hierarchy tree layout)            #
# --------------------------------------------------------------------------- #
# Hierarchical structure shown as classical tree-of-nodes (org chart,
# decision tree, taxonomy, file-system view). Data shape mirrors
# treemap/packing so authors can switch visualizations on the same
# rows without re-keying anything.
_TREE_ORIENTATIONS = ("vertical", "horizontal")
_TREE_NODE_SHAPES = ("rect", "circle")
_TREE_EDGE_STYLES = ("curve", "step", "straight")


def _tree_content(props: dict) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            "rows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "maxLength": 200},
                        "parent": {"type": "string", "maxLength": 200},
                        # Optional sublabel rendered under the main label
                        # (e.g. role for an org chart, count for a
                        # taxonomy node). Free-form short string.
                        "subtitle": {"type": "string", "maxLength": 200},
                        "color": {"type": "string", "maxLength": 32},
                    },
                    "additionalProperties": False,
                },
            },
            "orientation": {
                "type": "string",
                "enum": list(_TREE_ORIENTATIONS),
            },
            "node_shape": {
                "type": "string",
                "enum": list(_TREE_NODE_SHAPES),
            },
            # 'curve' (default): smooth bezier — best for most cases.
            # 'step': right-angle elbow joints — popular for org charts.
            # 'straight': plain line — minimal / dense trees.
            "edge_style": {
                "type": "string",
                "enum": list(_TREE_EDGE_STYLES),
            },
            # When set, every node is colored by its top-level ancestor
            # (matches treemap / packing's group coloring rule). When
            # unset, every node uses the same neutral color; per-row
            # `color` still wins either way.
            "color_by_group": {"type": "boolean"},
            # Visual sizing knobs — let authors trade between
            # readability and dense layouts without hand-tweaking SVG.
            "node_padding_x": {"type": "integer", "minimum": 0, "maximum": 80},
            "node_padding_y": {"type": "integer", "minimum": 0, "maximum": 80},
        },
        "additionalProperties": False,
    }


TREE: WidgetDescriptor = {
    "type": "tree",
    "label": "트리 다이어그램",
    "description": "노드·엣지 계층도 — 조직도, 분류 체계, 결정 트리, 파일 트리 등 (트리맵과 데이터 동일, 시각만 다름)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _tree_content,
    "default_props": {
        "label": "트리",
    },
}


# --------------------------------------------------------------------------- #
# 11i. network — node-and-edge graph (force-directed + alt layouts)            #
# --------------------------------------------------------------------------- #
# General graph: arbitrary nodes/edges, possibly cyclic, directed or
# undirected. Unlike tree/packing/treemap which share the long-form
# `rows: [{label, parent, ...}]` hierarchy shape, networks need an
# explicit `nodes[] + edges[]` model — there is no parent-child concept.
#
# Layout choices:
#   force    — d3-force simulation (default; physics-based)
#   circular — nodes on a circle
#   grid     — nodes on a square lattice
#   radial   — nodes grouped by `group` on concentric rings
#
# Node positions (x, y) are persisted in content. The frontend writes
# them back after the force simulation stabilizes or the user drags a
# node, so reopening / exporting reproduces the exact layout. Static
# layouts (circular/grid/radial) compute deterministically from the
# node list and ignore stored positions.
#
# Edge integrity (source/target reference an existing node id; no
# duplicate edges) is not expressible in pure JSON Schema. The
# renderer silently drops orphan edges and dedupes — mirroring the
# Tree widget's frontend-only cycle guard pattern.
_NETWORK_LAYOUTS = ("force", "circular", "grid", "radial")
_NETWORK_NODE_SHAPES = ("circle", "rect")


def _network_content(props: dict) -> dict:  # noqa: ARG001
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            "nodes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "minLength": 1, "maxLength": 200},
                        "label": {"type": "string", "maxLength": 200},
                        # Optional grouping key — drives `color_by_group`
                        # coloring and the radial layout's ring assignment.
                        "group": {"type": "string", "maxLength": 200},
                        # When `node_size_by_value` is on, this maps onto
                        # the node radius (linearly between node_size_min
                        # and node_size_max). Null / missing → mid-size.
                        "value": {"type": ["number", "null"]},
                        "color": {"type": "string", "maxLength": 64},
                        # Persisted layout position. Written by the
                        # frontend after the force sim stabilizes or
                        # the user drags. Optional — fresh imports
                        # without coords trigger a new simulation.
                        "x": {"type": "number"},
                        "y": {"type": "number"},
                        # When true, the node is pinned in the force
                        # simulation (won't move). Set by the renderer
                        # when the user "locks" a node.
                        "fixed": {"type": "boolean"},
                    },
                    "required": ["id"],
                    "additionalProperties": False,
                },
            },
            "edges": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "source": {"type": "string", "minLength": 1, "maxLength": 200},
                        "target": {"type": "string", "minLength": 1, "maxLength": 200},
                        # Affects forceLink target distance (heavier =
                        # shorter spring) and edge stroke-width.
                        "weight": {"type": "number"},
                        "label": {"type": "string", "maxLength": 200},
                        # Per-edge override of the widget-level `directed`.
                        # Omitted → inherit widget default.
                        "directed": {"type": "boolean"},
                        "color": {"type": "string", "maxLength": 64},
                    },
                    "required": ["source", "target"],
                    "additionalProperties": False,
                },
            },
            "directed": {"type": "boolean"},
            "layout": {
                "type": "string",
                "enum": list(_NETWORK_LAYOUTS),
            },
            "node_shape": {
                "type": "string",
                "enum": list(_NETWORK_NODE_SHAPES),
            },
            "show_labels": {"type": "boolean"},
            "show_edge_labels": {"type": "boolean"},
            # When true, every node colors by its `group` from the
            # rotating palette (matches treemap / packing). When false,
            # all nodes share a neutral; per-node `color` still wins.
            "color_by_group": {"type": "boolean"},
            # When true, node radius interpolates between
            # node_size_min and node_size_max based on `value`.
            "node_size_by_value": {"type": "boolean"},
            "node_size_min": {"type": "integer", "minimum": 2, "maximum": 80},
            "node_size_max": {"type": "integer", "minimum": 2, "maximum": 200},
            # Force-simulation knobs. Ignored by static layouts.
            "link_distance": {"type": "integer", "minimum": 10, "maximum": 400},
            "charge_strength": {"type": "integer", "minimum": -2000, "maximum": 0},
        },
        "additionalProperties": False,
    }


NETWORK: WidgetDescriptor = {
    "type": "network",
    "label": "네트워크 그래프",
    "description": "노드·엣지 일반 그래프 — force-directed / circular / grid / radial 레이아웃. 의존성, 인용, 소셜 네트워크 등 (비계층 데이터)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _network_content,
    "default_props": {
        "label": "네트워크",
    },
}


# --------------------------------------------------------------------------- #
# 11j. mind_map — radial / horizontal mind map (interactive node tree)         #
# --------------------------------------------------------------------------- #
# Data shape mirrors Tree/Treemap/Packing's `rows: [{label, parent, color}]`
# so authors can switch visualizations on the same hierarchy without
# re-keying. Distinct from Tree in two ways:
#   1. Layout — radial (root at center, branches 360°) or horizontal
#      (root center, level-1 children split left/right).
#   2. Editing UX — primary input is in-canvas (+ button on hover, inline
#      label edit, Tab/Enter/Delete shortcuts). The rows table is still
#      present for bulk edits / TSV paste.
_MIND_MAP_LAYOUTS = ("radial", "horizontal")
_MIND_MAP_BRANCH_STYLES = ("taper", "curve")


def _mind_map_content(props: dict) -> dict:  # noqa: ARG001
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            "rows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "maxLength": 200},
                        "parent": {"type": "string", "maxLength": 200},
                        "color": {"type": "string", "maxLength": 32},
                    },
                    "additionalProperties": False,
                },
            },
            # 'radial' (default): root at center, branches radiate 360°.
            # 'horizontal': root at center, level-1 children split left/right.
            "layout": {
                "type": "string",
                "enum": list(_MIND_MAP_LAYOUTS),
            },
            # 'taper' (default): branches drawn as filled paths thinning
            # from root → leaf (hand-drawn mind-map feel).
            # 'curve': uniform stroke width bezier.
            "branch_style": {
                "type": "string",
                "enum": list(_MIND_MAP_BRANCH_STYLES),
            },
            # When set, every level-1 child gets its own palette color and
            # descendants inherit a lightened version (matches the
            # treemap/packing/tree group-coloring rule). Per-row `color`
            # still wins.
            "color_by_group": {"type": "boolean"},
            # Emphasize the root with a padded ellipse + bold label.
            "show_root_emphasis": {"type": "boolean"},
        },
        "additionalProperties": False,
    }


MIND_MAP: WidgetDescriptor = {
    "type": "mind_map",
    "label": "마인드맵",
    "description": "방사형/좌우 분기 마인드맵 — 가지에 라벨이 얹힌 유기적 곡선. 캔버스에서 +버튼·키보드로 가지 쳐가며 편집 (트리와 데이터 동일)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _mind_map_content,
    "default_props": {
        "label": "마인드맵",
    },
}


PACKING: WidgetDescriptor = {
    "type": "packing",
    "label": "원형 패킹",
    "description": "계층 데이터를 원·원 패킹으로 (treemap 과 데이터 동일, 시각만 원형)",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _packing_content,
    "default_props": {
        "label": "패킹",
    },
}


TREEMAP: WidgetDescriptor = {
    "type": "treemap",
    "label": "트리맵",
    "description": "계층 데이터의 비중을 사각형 면적으로 — 비용 분해, 시장 점유, BoM 등",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _treemap_content,
    "default_props": {
        "label": "트리맵",
    },
}


# --------------------------------------------------------------------------- #
# 9e. radar — multi-axis polar comparison (spec sheets, scorecards)
# --------------------------------------------------------------------------- #
# Data shape mirrors the heatmap widget: positional `axis_labels[]`,
# a `series[]` of `{ label, color }`, and a 2-D `values[axis][series]`
# matrix. Each radar series traces a polygon through its values
# across the shared set of axes.
def _radar_content(props: dict) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            "axis_labels": {
                "type": "array",
                "items": {"type": "string", "maxLength": 200},
            },
            "series": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "maxLength": 200},
                        # Hex string ("#abcdef") or any CSS color name —
                        # frontend falls back to the rotating palette
                        # when omitted.
                        "color": {"type": "string", "maxLength": 64},
                    },
                    "additionalProperties": False,
                },
            },
            "values": {
                "type": "array",
                "items": {
                    "type": "array",
                    "items": {"type": ["number", "null"]},
                },
            },
            # Global radial range. Auto-fits when unset.
            "value_min": {"type": "number"},
            "value_max": {"type": "number"},
            # 0..1 alpha for the filled polygon underneath the
            # outline. 0 → just outline; ~0.3 default reads as "tinted
            # area" without obscuring overlapping series.
            "fill_opacity": {"type": "number", "minimum": 0, "maximum": 1},
            "show_legend": {"type": "boolean"},
        },
        "additionalProperties": False,
    }


RADAR: WidgetDescriptor = {
    "type": "radar",
    "label": "레이더 차트",
    "description": "다축 폴라 비교 — 사양 비교 / 평가표 / 다요소 점수",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _radar_content,
    "default_props": {
        "label": "레이더 차트",
    },
}


# --------------------------------------------------------------------------- #
# 9f. equation — LaTeX-rendered mathematical formula
# --------------------------------------------------------------------------- #
# Frontend renders via KaTeX so HTML / PDF export work without
# a runtime math typesetter (KaTeX emits static HTML+SVG). DOCX
# export currently embeds the rendered cell as a PNG via the same
# visual-block capture path other charts use — math doesn't have a
# clean text equivalent.
_EQUATION_DISPLAY_MODES = ("display", "inline")


def _equation_content(props: dict) -> dict:
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            # Raw LaTeX source. Limit is generous (5K chars) because
            # multi-line `\begin{align}…\end{align}` blocks can be
            # surprisingly long even for routine engineering work.
            "latex": {"type": "string", "maxLength": 5000},
            # display mode = centered, large, on its own line (default)
            # inline       = small, baseline-aligned for embedded use
            "display_mode": {
                "type": "string",
                "enum": list(_EQUATION_DISPLAY_MODES),
            },
            # Optional equation number / tag — e.g. "(1)", "(eq. 3.2)".
            # Rendered on the right of the formula in display mode.
            "number": {"type": "string", "maxLength": 64},
        },
        "additionalProperties": False,
    }


EQUATION: WidgetDescriptor = {
    "type": "equation",
    "label": "수식",
    "description": "LaTeX 문법의 수학식 — 지배 방정식, 정의식, 회귀식 등",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _equation_content,
    "default_props": {
        "label": "수식",
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
# 9e. comparison — AS-IS vs TO-BE / 여러 CASE 비교 (행별 텍스트 or 이미지)
# --------------------------------------------------------------------------- #
# Layout is row-major: each ROW is a comparison attribute (설명, 사진, 지표 ...)
# and each COLUMN is a CASE (AS-IS / TO-BE, or CASE A / B / C). Cells of a
# text-kind row carry strings; cells of an image-kind row carry a single
# uploaded file_id. Writers can mix the two kinds freely in one table —
# the row's `kind` decides which input renders. Cases live in props
# (template default) and may be overridden per-report via content.cases.
_COMPARISON_ROW_KINDS = ("text", "image")

# Re-use the same {key, label} pattern as raci_matrix / chart so the
# `key` is a stable slug while `label` stays freely editable.
_COMPARISON_CASE_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "key": {
            "type": "string",
            "pattern": r"^[a-z][a-z0-9_]*$",
            "maxLength": 64,
        },
        "label": {"type": "string", "maxLength": 200},
    },
    "required": ["key"],
    "additionalProperties": False,
}


def _comparison_content(props: dict) -> dict:  # noqa: ARG001
    # Per-cell value shape — strings for text rows, {file_id, alt?} for
    # image rows. We accept either at the schema level since `kind` is
    # the source of truth, and the editor is responsible for keeping
    # cell values in sync with kind. Empty cell = missing key on the
    # `values` object (legal for partial drafts).
    cell_value_schema = {
        "oneOf": [
            {"type": "string", "maxLength": 4000},
            {
                "type": "object",
                "properties": {
                    "file_id": {"type": "string", "minLength": 1},
                    "alt": {"type": "string", "maxLength": 200},
                    "caption": {"type": "string", "maxLength": 500},
                },
                "required": ["file_id"],
                "additionalProperties": False,
            },
        ],
    }
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            # Per-report case override. When set, this is the canonical
            # column list (renamed/added/removed cases); when absent,
            # the renderer falls back to props.cases.
            "cases": {
                "type": "array",
                "items": _COMPARISON_CASE_ITEM_SCHEMA,
            },
            # Per-report layout overrides — same fields as the matching
            # props but tunable by the writer in the "위젯 편집" toolbar
            # without touching the template. Renderer reads
            # `content.<field> ?? props.<field> ?? default`. Mirrors the
            # `chart_type` pattern: props sets the template default,
            # content lets the report override it.
            "horizontal_scroll": {"type": "boolean"},
            "max_cases": {"type": "integer", "minimum": 2, "maximum": 30},
            "image_max_height_px": {
                "type": "integer",
                "minimum": 80,
                "maximum": 600,
            },
            "rows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "key": {
                            "type": "string",
                            "pattern": r"^[a-z][a-z0-9_]*$",
                            "maxLength": 64,
                        },
                        "label": {"type": "string", "maxLength": 200},
                        "kind": {
                            "type": "string",
                            "enum": list(_COMPARISON_ROW_KINDS),
                        },
                        "values": {
                            "type": "object",
                            # Cell keys are case keys — same slug shape.
                            "patternProperties": {
                                r"^[a-z][a-z0-9_]{0,63}$": cell_value_schema,
                            },
                            "additionalProperties": False,
                        },
                    },
                    "required": ["key", "kind"],
                    "additionalProperties": False,
                },
            },
        },
        "additionalProperties": False,
    }


COMPARISON: WidgetDescriptor = {
    "type": "comparison",
    "label": "비교 표",
    "description": "AS-IS / TO-BE 또는 여러 CASE를 열로, 비교 항목을 행으로 — 행은 텍스트/숫자 행과 이미지 행을 자유롭게 섞을 수 있음",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            # Default case columns. Writers can rename / add / remove
            # per report via content.cases (mirrors the raci_matrix
            # "default_roles → content.roles" pattern).
            "cases": {
                "type": "array",
                "minItems": 1,
                "items": _COMPARISON_CASE_ITEM_SCHEMA,
            },
            # When False (default), the table fits the available width
            # without horizontal scroll — case columns share width
            # equally via `table-fixed`. `max_cases` caps how many can
            # fit before columns get unreadably narrow.
            # When True, the writer can add many cases; the table
            # overflows horizontally with a per-column min-width so
            # each case stays readable.
            "horizontal_scroll": {"type": "boolean"},
            # Soft cap on the case-column count when horizontal_scroll
            # is False. Ignored when scroll is on. Default chosen so a
            # 12-column-grid row stays readable at ~150px per case.
            "max_cases": {"type": "integer", "minimum": 2, "maximum": 30},
            # Per-image-row max height in px. Image cells use a fixed
            # `aspect-video` ratio but cap their height here so the
            # whole-report fullscreen view (which removes the page
            # width cap) doesn't make image rows grow unboundedly tall
            # — that was creating a vertical scrollbar that wasn't
            # there in normal view.
            "image_max_height_px": {
                "type": "integer",
                "minimum": 80,
                "maximum": 600,
            },
            "text_style": _TEXT_STYLE_SCHEMA,
        },
        "required": ["label", "cases"],
        "additionalProperties": False,
    },
    "content_schema_for": _comparison_content,
    "default_props": {
        "label": "비교 표",
        "cases": [
            {"key": "as_is", "label": "AS-IS"},
            {"key": "to_be", "label": "TO-BE"},
        ],
        "horizontal_scroll": False,
        "max_cases": 6,
        "image_max_height_px": 240,
    },
}


# --------------------------------------------------------------------------- #
# 10. cad_3d — 3D 모델 뷰어 (Phase 1: GLB/GLTF/STL/OBJ)
# --------------------------------------------------------------------------- #
# Single-file widget: the user uploads one 3D model and the frontend
# renders it via Three.js. Camera state lives in content.view_state so
# the saved report opens at the writer-chosen angle. Annotations are
# OUT of Phase 1 scope — Phase 2 adds world-space distance measures
# on top of this shape.
_CAD_VIEW_PRESETS = ("iso", "front", "top", "side", "fit")


# World-space 3D point used by cad_3d annotations. Coordinates are in
# the model's native unit (we assume mm by convention; props.unit only
# affects display in the UI).
_CAD_POINT_SCHEMA = {
    "type": "object",
    "properties": {
        "x": {"type": "number"},
        "y": {"type": "number"},
        "z": {"type": "number"},
    },
    "required": ["x", "y", "z"],
    "additionalProperties": False,
}


def _cad_3d_content(props: dict) -> dict:  # noqa: ARG001
    return {
        "type": "object",
        "properties": {
            "caption": _CAPTION_FIELD,
            "caption_skip_autofill": {"type": "boolean"},
            # Reference to a single uploaded model file (GLB/GLTF/STL/...).
            # Same file_id contract as image/attachment widgets.
            "file_id": {"type": "string", "minLength": 1},
            # Display-only; the actual bytes live keyed by file_id. Useful
            # for "this widget shows model_X.glb" in lists / DOCX export.
            "loaded_filename": {"type": "string", "maxLength": 255},
            # Camera persistence. Optional — when absent the viewer
            # falls back to props.default_view + auto-fit to bounding box.
            "view_state": {
                "type": "object",
                "properties": {
                    "position": {
                        "type": "array",
                        "items": {"type": "number"},
                        "minItems": 3,
                        "maxItems": 3,
                    },
                    "target": {
                        "type": "array",
                        "items": {"type": "number"},
                        "minItems": 3,
                        "maxItems": 3,
                    },
                    "zoom": {"type": "number"},
                    # Toolbar toggles snapshotted by "뷰 저장" so a
                    # reader lands on the exact same view the author
                    # set up — without these the camera would snap
                    # back but the grid / axes / parts sidebar would
                    # revert to whatever the local UI defaults are.
                    "show_grid": {"type": "boolean"},
                    "show_axes": {"type": "boolean"},
                    "sidebar_open": {"type": "boolean"},
                },
                "additionalProperties": False,
            },
            # Names of parts the report author wants hidden by default.
            # The viewer can locally override these (transient state in
            # the widget) without dirtying this list. Part identity =
            # the GLB/GLTF node `name` of the model's first level of
            # named children; falls back to a positional `_unnamed_<i>`
            # token for unnamed nodes (rare, but stable).
            "hidden_parts": {
                "type": "array",
                "items": {"type": "string", "maxLength": 200},
            },
            # Names of parts the author wants shown as wireframe (no
            # solid fill). Independent of hidden_parts: a part listed
            # here AND in hidden_parts is hidden (hidden wins).
            "wireframe_parts": {
                "type": "array",
                "items": {"type": "string", "maxLength": 200},
            },
            # Phase 2: world-space measurement annotations. Distinct shape
            # from chart/image annotations (those live in 2D pct space).
            # `distance_3d`: line between p1 and p2, label shows the
            #                Euclidean distance + per-axis breakdown.
            # `point_3d`:    single tagged point, label is freeform note.
            "annotations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "minLength": 1, "maxLength": 64},
                        "type": {
                            "type": "string",
                            "enum": ["distance_3d", "point_3d"],
                        },
                        "p1": _CAD_POINT_SCHEMA,
                        # Only required for distance_3d — point_3d skips this.
                        "p2": _CAD_POINT_SCHEMA,
                        "label": {"type": "string", "maxLength": 200},
                        "color": {
                            "type": "string",
                            "pattern": r"^#[0-9a-fA-F]{6}$",
                        },
                    },
                    "required": ["id", "type", "p1"],
                    "additionalProperties": False,
                },
            },
        },
        "additionalProperties": False,
    }


CAD_3D: WidgetDescriptor = {
    "type": "cad_3d",
    "label": "3D 모델",
    "description": "3D CAD 모델 뷰어 (GLB/GLTF/STL/OBJ) — 회전·줌·뷰 프리셋",
    "has_content": True,
    "props_schema": {
        "type": "object",
        "properties": {
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            # mm/cm/m — used by Phase-2 measurements. Phase 1 surfaces
            # it as a label hint near the canvas.
            "unit": {"type": "string", "enum": ["mm", "cm", "m"]},
            "default_view": {
                "type": "string",
                "enum": list(_CAD_VIEW_PRESETS),
            },
            "show_grid": {"type": "boolean"},
            "show_axes": {"type": "boolean"},
            "background": {
                "type": "string",
                "pattern": r"^#[0-9a-fA-F]{6}$",
            },
        },
        "required": ["label"],
        "additionalProperties": False,
    },
    "content_schema_for": _cad_3d_content,
    "default_props": {
        "label": "3D 모델",
        "unit": "mm",
        "default_view": "iso",
        "show_grid": True,
        "show_axes": True,
        "background": "#f8fafc",
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
        VIDEO,
        HTML_EMBED,
        CHART,
        SCATTER,
        SCATTER3D,
        HEATMAP,
        CONTOUR,
        TREEMAP,
        PACKING,
        TREE,
        NETWORK,
        MIND_MAP,
        PIE,
        WAFFLE,
        BOX,
        DENSITY,
        RADAR,
        EQUATION,
        MILESTONE,
        FLOWCHART,
        PROGRESS_BAR,
        RACI_MATRIX,
        COMPARISON,
        CAD_3D,
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
