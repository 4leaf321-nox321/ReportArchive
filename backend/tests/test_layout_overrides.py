"""Validation tests for report-side layout_overrides.

The widget validator should accept overrides that:
  - reference only existing template block ids
  - have valid {row, col_span, row_span} shapes
  - keep each row's col_span sum within GRID_COLS

…and reject the inverses.
"""
import pytest

from app.widgets import validate_layout_overrides


def _template():
    return {
        "version": "widget-v1",
        "blocks": [
            {"id": "a", "type": "rich_text", "props": {"label": "A"},
             "layout": {"row": 1, "col_span": 6, "row_span": 2}},
            {"id": "b", "type": "rich_text", "props": {"label": "B"},
             "layout": {"row": 1, "col_span": 6, "row_span": 2}},
            {"id": "c", "type": "rich_text", "props": {"label": "C"},
             "layout": {"row": 2, "col_span": 12, "row_span": 4}},
        ],
    }


def test_none_or_empty_overrides_pass():
    validate_layout_overrides(_template(), None)
    validate_layout_overrides(_template(), {})


def test_valid_partial_override_passes():
    """Resize one block — the rest stay on template layout."""
    overrides = {
        "c": {"row": 2, "col_span": 12, "row_span": 8},  # taller table
    }
    validate_layout_overrides(_template(), overrides)


def test_full_row_replacement_passes():
    overrides = {
        "a": {"row": 1, "col_span": 8, "row_span": 2},
        "b": {"row": 1, "col_span": 4, "row_span": 2},
    }
    validate_layout_overrides(_template(), overrides)


def test_unknown_block_id_rejected():
    overrides = {"ghost": {"row": 1, "col_span": 12, "row_span": 1}}
    with pytest.raises(ValueError, match="unknown block"):
        validate_layout_overrides(_template(), overrides)


def test_overflowing_row_after_override_rejected():
    """Overriding `a` to col_span=10 leaves only 2 for `b` (still 6) — overflow."""
    overrides = {"a": {"row": 1, "col_span": 10, "row_span": 2}}
    with pytest.raises(ValueError, match="Row 1: col_span sum"):
        validate_layout_overrides(_template(), overrides)


def test_invalid_layout_shape_rejected():
    with pytest.raises(ValueError, match="layout"):
        validate_layout_overrides(_template(), {"a": {"row": 0, "col_span": 6}})


def test_legacy_template_rejected():
    legacy = {"properties": {"a": {"type": "string"}}}
    with pytest.raises(ValueError, match="not widget-v1"):
        validate_layout_overrides(legacy, {"a": {"row": 1, "col_span": 12, "row_span": 1}})


def test_auto_fit_flag_accepted():
    """auto_fit toggles content-driven row_span — must be allowed alongside the
    persisted row_span baseline so non-JS renderers stay deterministic."""
    overrides = {
        "c": {"row": 2, "col_span": 12, "row_span": 4, "auto_fit": True},
    }
    validate_layout_overrides(_template(), overrides)


def test_auto_fit_must_be_boolean():
    overrides = {"c": {"row": 2, "col_span": 12, "row_span": 4, "auto_fit": "yes"}}
    with pytest.raises(ValueError, match="auto_fit"):
        validate_layout_overrides(_template(), overrides)
