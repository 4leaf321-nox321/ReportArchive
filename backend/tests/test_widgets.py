"""Unit tests for the widget registry and widget-v1 validation.

Run from backend/: `python -m pytest tests/test_widgets.py -v`
"""
import pytest

from app.widgets import (
    WIDGET_REGISTRY,
    is_widget_v1,
    list_widget_descriptors,
    validate_report_content,
    validate_template_schema,
)


# --------------------------------------------------------------------------- #
# Registry self-checks
# --------------------------------------------------------------------------- #
def test_registry_has_all_widgets():
    expected = {
        "heading",
        "rich_text",
        "key_value",
        "bulleted_list",
        "table",
        "kpi_card",
        "image",
        "attachment",
        "chart",
    }
    assert set(WIDGET_REGISTRY) == expected


def test_every_widget_default_props_pass_their_props_schema():
    """Hard guarantee: a widget's default_props must validate against its
    own props_schema, otherwise dragging it into a template would create
    an invalid template by default."""
    import jsonschema

    for type_, w in WIDGET_REGISTRY.items():
        defaults = w.get("default_props", {})
        try:
            jsonschema.validate(instance=defaults, schema=w["props_schema"])
        except jsonschema.ValidationError as exc:
            pytest.fail(f"Widget {type_!r} default_props invalid: {exc.message}")
        # Also: derive the content schema from defaults to make sure
        # content_schema_for is wired up.
        w["content_schema_for"](defaults)


def test_list_widget_descriptors_has_no_callables():
    """The public catalog must be JSON-serializable."""
    import json

    descs = list_widget_descriptors()
    json.dumps(descs)  # raises if any non-serializable values slip through
    assert len(descs) == len(WIDGET_REGISTRY)


# --------------------------------------------------------------------------- #
# Template schema validation
# --------------------------------------------------------------------------- #
def _minimal_widget_v1():
    return {
        "version": "widget-v1",
        "blocks": [
            {
                "id": "summary",
                "type": "rich_text",
                "props": {"label": "주간 요약"},
            }
        ],
    }


def test_is_widget_v1_detects_version():
    assert is_widget_v1({"version": "widget-v1", "blocks": []}) is True
    assert is_widget_v1({"version": "json-schema", "blocks": []}) is False
    assert is_widget_v1({}) is False
    assert is_widget_v1(None) is False


def test_validate_template_happy_path():
    validate_template_schema(_minimal_widget_v1())  # should not raise


def test_validate_template_rejects_unknown_widget_type():
    schema = _minimal_widget_v1()
    schema["blocks"][0]["type"] = "what_is_this"
    with pytest.raises(ValueError, match="unknown widget type"):
        validate_template_schema(schema)


def test_validate_template_rejects_duplicate_block_ids():
    schema = {
        "version": "widget-v1",
        "blocks": [
            {"id": "x", "type": "rich_text", "props": {"label": "A"}},
            {"id": "x", "type": "rich_text", "props": {"label": "B"}},
        ],
    }
    with pytest.raises(ValueError, match="Duplicate block id"):
        validate_template_schema(schema)


def test_validate_template_rejects_invalid_block_id_pattern():
    schema = _minimal_widget_v1()
    schema["blocks"][0]["id"] = "Has-Hyphen"
    with pytest.raises(ValueError, match="id must match"):
        validate_template_schema(schema)


def test_validate_template_rejects_select_without_options():
    """Cross-field rule beyond what JSON Schema handles cleanly."""
    schema = {
        "version": "widget-v1",
        "blocks": [
            {
                "id": "meta",
                "type": "key_value",
                "props": {
                    "items": [
                        {"key": "k", "label": "K", "type": "select", "options": []}
                    ]
                },
            }
        ],
    }
    with pytest.raises(ValueError, match="no options"):
        validate_template_schema(schema)


def test_validate_template_rejects_duplicate_column_keys():
    schema = {
        "version": "widget-v1",
        "blocks": [
            {
                "id": "tbl",
                "type": "table",
                "props": {
                    "label": "T",
                    "columns": [
                        {"key": "k", "label": "K1", "type": "text"},
                        {"key": "k", "label": "K2", "type": "text"},
                    ],
                },
            }
        ],
    }
    with pytest.raises(ValueError, match="duplicate key"):
        validate_template_schema(schema)


def test_validate_template_rejects_wrong_version():
    with pytest.raises(ValueError, match="version must be 'widget-v1'"):
        validate_template_schema({"version": "v2", "blocks": []})


def test_validate_template_rejects_empty_blocks():
    with pytest.raises(ValueError, match="at least one block"):
        validate_template_schema({"version": "widget-v1", "blocks": []})


# --------------------------------------------------------------------------- #
# Chart widget
# --------------------------------------------------------------------------- #
def _chart_template():
    return {
        "version": "widget-v1",
        "blocks": [
            {
                "id": "trend",
                "type": "chart",
                "props": {
                    "label": "분기 매출",
                    "chart_type": "bar",
                    "x_column_key": "quarter",
                    "columns": [
                        {"key": "quarter", "label": "분기", "type": "text"},
                        {"key": "revenue", "label": "매출", "type": "number"},
                        {"key": "cost", "label": "비용", "type": "number"},
                    ],
                },
            }
        ],
    }


def test_chart_widget_template_accepts():
    validate_template_schema(_chart_template())


def test_chart_widget_rejects_x_column_not_in_columns():
    schema = _chart_template()
    schema["blocks"][0]["props"]["x_column_key"] = "ghost"
    with pytest.raises(ValueError, match="x_column_key"):
        validate_template_schema(schema)


def test_chart_widget_rejects_non_numeric_series():
    schema = _chart_template()
    schema["blocks"][0]["props"]["columns"].append(
        {"key": "note", "label": "메모", "type": "text"}
    )
    with pytest.raises(ValueError, match="series columns must be 'number'"):
        validate_template_schema(schema)


def test_chart_widget_content_accepts_overrides():
    template = _chart_template()
    content = {
        "trend": {
            "caption": "1분기 비중",
            "chart_type": "line",
            "rows": [
                {"quarter": "Q1", "revenue": 100, "cost": 60},
                {"quarter": "Q2", "revenue": 120, "cost": 70},
            ],
        }
    }
    validate_report_content(template, content)


def test_chart_widget_content_rejects_unknown_chart_type():
    template = _chart_template()
    content = {"trend": {"chart_type": "pie"}}
    with pytest.raises(ValueError, match="trend"):
        validate_report_content(template, content)


# --------------------------------------------------------------------------- #
# Layout validation
# --------------------------------------------------------------------------- #
def test_validate_template_accepts_blocks_without_layout():
    """Layout is optional; blocks without one fall back to 1D rendering."""
    schema = _minimal_widget_v1()
    validate_template_schema(schema)  # should not raise


def test_validate_template_accepts_valid_layout():
    schema = {
        "version": "widget-v1",
        "blocks": [
            {"id": "a", "type": "rich_text", "props": {"label": "A"},
             "layout": {"row": 1, "col_span": 6}},
            {"id": "b", "type": "rich_text", "props": {"label": "B"},
             "layout": {"row": 1, "col_span": 6}},
            {"id": "c", "type": "rich_text", "props": {"label": "C"},
             "layout": {"row": 2, "col_span": 12, "row_span": 2}},
        ],
    }
    validate_template_schema(schema)


def test_validate_template_rejects_overflowing_row():
    schema = {
        "version": "widget-v1",
        "blocks": [
            {"id": "a", "type": "rich_text", "props": {"label": "A"},
             "layout": {"row": 1, "col_span": 8}},
            {"id": "b", "type": "rich_text", "props": {"label": "B"},
             "layout": {"row": 1, "col_span": 8}},
        ],
    }
    with pytest.raises(ValueError, match="Row 1: col_span sum is 16"):
        validate_template_schema(schema)


def test_validate_template_rejects_col_span_out_of_range():
    schema = {
        "version": "widget-v1",
        "blocks": [
            {"id": "a", "type": "rich_text", "props": {"label": "A"},
             "layout": {"row": 1, "col_span": 13}},
        ],
    }
    with pytest.raises(ValueError, match="layout/col_span"):
        validate_template_schema(schema)


def test_validate_template_rejects_row_zero():
    schema = {
        "version": "widget-v1",
        "blocks": [
            {"id": "a", "type": "rich_text", "props": {"label": "A"},
             "layout": {"row": 0, "col_span": 6}},
        ],
    }
    with pytest.raises(ValueError, match="layout/row"):
        validate_template_schema(schema)


def test_validate_template_rejects_unknown_layout_field():
    schema = {
        "version": "widget-v1",
        "blocks": [
            {"id": "a", "type": "rich_text", "props": {"label": "A"},
             "layout": {"row": 1, "col_span": 6, "x": 0}},
        ],
    }
    with pytest.raises(ValueError, match="layout"):
        validate_template_schema(schema)


# --------------------------------------------------------------------------- #
# Report content validation
# --------------------------------------------------------------------------- #
def _full_template():
    return {
        "version": "widget-v1",
        "blocks": [
            {
                "id": "h_intro",
                "type": "heading",
                "props": {"level": 2, "default_text": "주간 보고"},
            },
            {
                "id": "meta",
                "type": "key_value",
                "props": {
                    "items": [
                        {"key": "period", "label": "기간", "type": "text", "required": True},
                        {"key": "team", "label": "팀", "type": "select",
                         "options": ["dev", "biz"], "required": True},
                    ]
                },
            },
            {
                "id": "summary",
                "type": "rich_text",
                "props": {"label": "요약"},
            },
            {
                "id": "todos",
                "type": "bulleted_list",
                "props": {"label": "할 일", "min_items": 1},
            },
            {
                "id": "issues",
                "type": "table",
                "props": {
                    "label": "이슈",
                    "columns": [
                        {"key": "title", "label": "제목", "type": "text", "required": True},
                        {"key": "owner", "label": "담당", "type": "text"},
                    ],
                },
            },
            {
                "id": "kpi",
                "type": "kpi_card",
                "props": {"label": "매출", "allow_delta": True, "allow_note": True},
            },
        ],
    }


def test_validate_content_happy_path():
    template = _full_template()
    content = {
        "meta": {"period": "2026-W19", "team": "dev"},
        "summary": {"markdown": "이번 주는..."},
        "todos": {"items": ["기능 출시", "문서 작성"]},
        "issues": {"rows": [{"title": "장애 대응", "owner": "홍길동"}]},
        "kpi": {"value": 12.3, "delta": 0.5, "note": "전주 대비"},
    }
    validate_report_content(template, content)  # should not raise


def test_validate_content_partial_draft_is_allowed():
    template = _full_template()
    content = {"summary": {"markdown": "초안"}}  # missing other blocks is OK
    validate_report_content(template, content)


def test_validate_content_rejects_unknown_block_id():
    template = _full_template()
    content = {"summary": {"markdown": "x"}, "ghost": {"foo": 1}}
    with pytest.raises(ValueError, match="unknown block ids"):
        validate_report_content(template, content)


def test_validate_content_allows_missing_kv_field_in_draft():
    """Per-item `required` on key_value is now a UI hint only — the schema
    keeps body fields optional so a writer can save a caption-only draft.
    Strict required-field enforcement happens at submission time (future),
    not on every save."""
    template = _full_template()
    content = {"meta": {"period": "2026-W19"}}  # 'team' is "required" per template
    validate_report_content(template, content)  # should not raise


def test_validate_content_accepts_caption_only():
    """Every non-heading widget supports a block-level `caption` content
    field. Saving just `{caption: "X"}` for any block must validate."""
    template = _full_template()
    content = {
        "meta": {"caption": "헤더 메타"},
        "summary": {"caption": "요약"},
        "todos": {"caption": "할 일"},
        "issues": {"caption": "이슈"},
        "kpi": {"caption": "지표"},
    }
    validate_report_content(template, content)


def test_validate_content_rejects_invalid_kv_field_type():
    """Type checks on present fields still apply — only `required` is relaxed."""
    template = _full_template()
    # 'team' is a select; "ghost" not in enum.
    content = {"meta": {"team": "ghost"}}
    with pytest.raises(ValueError, match="meta"):
        validate_report_content(template, content)


def test_validate_content_rejects_select_value_outside_options():
    template = _full_template()
    content = {"meta": {"period": "x", "team": "ghost"}}
    with pytest.raises(ValueError, match="meta"):
        validate_report_content(template, content)


def test_validate_content_allows_extra_column_in_table_row():
    """Reports can extend / redefine table columns at write time — rows are
    validated as loose objects, not against the template's column set."""
    template = _full_template()
    content = {"issues": {"rows": [{"title": "x", "owner": "y", "ghost": 1}]}}
    validate_report_content(template, content)  # should not raise


def test_validate_content_accepts_per_report_table_columns():
    """A report can carry its own `columns` override on a table block."""
    template = _full_template()
    content = {
        "issues": {
            "columns": [
                {"key": "title", "label": "제목", "type": "text"},
                {"key": "extra", "label": "추가", "type": "text"},
            ],
            "rows": [{"title": "x", "extra": "y"}],
        }
    }
    validate_report_content(template, content)


def test_validate_content_rejects_invalid_per_report_columns():
    """Custom columns must still match the column-definition schema."""
    template = _full_template()
    content = {
        "issues": {
            "columns": [{"key": "Bad-Key", "label": "x", "type": "text"}],  # invalid key pattern
        }
    }
    with pytest.raises(ValueError, match="issues"):
        validate_report_content(template, content)


def test_validate_content_rejects_min_items_violation():
    template = _full_template()
    content = {"todos": {"items": []}}  # min_items=1
    with pytest.raises(ValueError, match="todos"):
        validate_report_content(template, content)


def test_validate_content_rejects_kpi_with_disallowed_field():
    template = {
        "version": "widget-v1",
        "blocks": [
            {
                "id": "k",
                "type": "kpi_card",
                "props": {"label": "x"},  # allow_delta=False, allow_note=False
            }
        ],
    }
    content = {"k": {"value": 1, "delta": 2}}  # delta not allowed
    with pytest.raises(ValueError, match="k"):
        validate_report_content(template, content)


def test_validate_content_accepts_heading_text():
    """Heading carries an editable `text` content slot now."""
    template = _full_template()
    content = {"h_intro": {"text": "12주차 보고"}}
    validate_report_content(template, content)  # should not raise


def test_validate_content_rejects_extra_field_in_heading():
    template = _full_template()
    content = {"h_intro": {"text": "x", "ghost": 1}}
    with pytest.raises(ValueError, match="h_intro"):
        validate_report_content(template, content)


def test_validate_content_rejects_legacy_schema():
    legacy = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {"summary": {"type": "string"}},
    }
    with pytest.raises(ValueError, match="not widget-v1"):
        validate_report_content(legacy, {})
