"""Validation tests for ontology / aggregation `meta` annotations on
template blocks and field items.

Meta is a hint layer — purely optional. The validator should accept all
valid shapes, reject unknown keys, and reject bad enum values.
"""
import pytest

from app.widgets import validate_template_schema


def _block(meta=None, type_="rich_text", props=None, extra=None):
    block = {
        "id": "summary",
        "type": type_,
        "props": props or {"label": "주간 요약"},
    }
    if meta is not None:
        block["meta"] = meta
    if extra:
        block.update(extra)
    return {"version": "widget-v1", "blocks": [block]}


# --------------------------------------------------------------------------- #
# Block-level meta
# --------------------------------------------------------------------------- #
def test_block_without_meta_passes():
    validate_template_schema(_block(meta=None))


def test_block_with_full_meta_passes():
    validate_template_schema(
        _block(
            meta={
                "concept": "WeeklyDevSummary",
                "category": "note",
                "aggregatable": "list",
                "tags": ["weekly", "dev"],
                "ai_prompt": "이번주 핵심 3-5줄로 요약",
            }
        )
    )


def test_block_with_partial_meta_passes():
    validate_template_schema(_block(meta={"concept": "Anything"}))


def test_block_meta_rejects_unknown_field():
    with pytest.raises(ValueError, match="meta"):
        validate_template_schema(_block(meta={"weird_field": "x"}))


def test_block_meta_rejects_invalid_category():
    with pytest.raises(ValueError, match="meta/category"):
        validate_template_schema(_block(meta={"category": "ghost"}))


def test_block_meta_rejects_invalid_aggregation():
    with pytest.raises(ValueError, match="meta/aggregatable"):
        validate_template_schema(_block(meta={"aggregatable": "median"}))


def test_block_meta_rejects_non_object():
    with pytest.raises(ValueError, match="meta"):
        validate_template_schema(_block(meta="just a string"))


# --------------------------------------------------------------------------- #
# Field-level meta (key_value items, table columns, chart columns)
# --------------------------------------------------------------------------- #
def _key_value_with_field_meta(field_meta):
    return {
        "version": "widget-v1",
        "blocks": [
            {
                "id": "meta",
                "type": "key_value",
                "props": {
                    "items": [
                        {
                            "key": "owner",
                            "label": "작성자",
                            "type": "text",
                            "meta": field_meta,
                        }
                    ]
                },
            }
        ],
    }


def test_key_value_field_meta_passes():
    validate_template_schema(
        _key_value_with_field_meta(
            {
                "concept": "Person",
                "is_entity_id": True,
                "linked_entity_type": "user",
            }
        )
    )


def test_key_value_field_meta_rejects_unknown_key():
    with pytest.raises(ValueError, match="meta"):
        validate_template_schema(_key_value_with_field_meta({"random": "x"}))


def test_table_column_meta_passes():
    schema = {
        "version": "widget-v1",
        "blocks": [
            {
                "id": "issues",
                "type": "table",
                "props": {
                    "label": "이슈",
                    "columns": [
                        {
                            "key": "owner",
                            "label": "담당",
                            "type": "text",
                            "meta": {"concept": "Person", "is_entity_id": True},
                        }
                    ],
                },
            }
        ],
    }
    validate_template_schema(schema)


def test_chart_column_meta_passes():
    schema = {
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
                        {
                            "key": "quarter",
                            "label": "분기",
                            "type": "text",
                            "meta": {"concept": "Period"},
                        },
                        {
                            "key": "revenue",
                            "label": "매출",
                            "type": "number",
                            "meta": {
                                "concept": "Revenue",
                                "category": "metric",
                                "aggregatable": "sum",
                            },
                        },
                    ],
                },
            }
        ],
    }
    validate_template_schema(schema)


def test_field_meta_rejects_invalid_enum():
    with pytest.raises(ValueError, match="aggregatable"):
        validate_template_schema(
            _key_value_with_field_meta({"aggregatable": "median"})
        )
