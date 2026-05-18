"""widget-v1 validation.

Two entry points:
  - validate_template_schema(schema_doc): called when a template is saved.
    Checks the doc shape, every block's props, and id uniqueness.
  - validate_report_content(template_schema, content): called when a report
    is saved. For each block in the template, validates the corresponding
    content slot (if present) against the widget's content schema.

Drafts may be partial: a missing block_id in content is allowed. Anything
present must match its schema.
"""
from __future__ import annotations

import re
from typing import Any, Optional

import jsonschema

from app.widgets.registry import WIDGET_REGISTRY, get_widget


TEMPLATE_SCHEMA_VERSION = "widget-v1"

_BLOCK_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

GRID_COLS = 12

_LAYOUT_PROPS_SCHEMA = {
    "type": "object",
    "properties": {
        "row": {"type": "integer", "minimum": 1},
        "col_span": {"type": "integer", "minimum": 1, "maximum": GRID_COLS},
        "row_span": {"type": "integer", "minimum": 1},
        # When true, the renderer auto-fits row_span to the widget's natural
        # content height (both edit and view mode). row_span still gets
        # persisted so server-side renders / list views stay deterministic.
        "auto_fit": {"type": "boolean"},
    },
    "required": ["row", "col_span"],
    "additionalProperties": False,
}


# Optional ontology / aggregation / AI hints attached to a block or a
# sub-field (key_value item, table column, chart column). All fields are
# optional — meta is purely a hint layer for downstream pipelines (entity
# extraction, cross-report aggregation, AI prompt assembly).
META_CATEGORIES = ("metric", "event", "entity", "note", "reference", "attribute")
META_AGGREGATIONS = ("sum", "avg", "count", "list", "max", "min", "none")

META_SCHEMA = {
    "type": "object",
    "properties": {
        # Ontology concept/class this block or field represents.
        # E.g., "MonthlyRevenue" for a kpi_card, "Team" for a key_value field.
        "concept": {"type": "string", "maxLength": 100},
        # High-level category the concept belongs to.
        "category": {"type": "string", "enum": list(META_CATEGORIES)},
        # How values across reports should roll up.
        "aggregatable": {"type": "string", "enum": list(META_AGGREGATIONS)},
        # Free-form tags for filtering / discovery.
        "tags": {
            "type": "array",
            "items": {"type": "string", "minLength": 1, "maxLength": 50},
        },
        # Hint AI uses when generating this block's content.
        "ai_prompt": {"type": "string", "maxLength": 1000},
        # Marks this field as an entity identifier — its value should be
        # promoted into the entities table for cross-report linking.
        "is_entity_id": {"type": "boolean"},
        # Identifier of the entity type this field links to (e.g. "user",
        # "workspace", "project"). Read by the entity extraction job.
        "linked_entity_type": {"type": "string", "maxLength": 64},
    },
    "additionalProperties": False,
}


def is_widget_v1(schema_doc: Any) -> bool:
    return (
        isinstance(schema_doc, dict)
        and schema_doc.get("version") == TEMPLATE_SCHEMA_VERSION
    )


# --------------------------------------------------------------------------- #
# Template (widget-v1) validation
# --------------------------------------------------------------------------- #
def validate_template_schema(schema_doc: dict) -> None:
    """Raises ValueError on any structural problem."""
    if not isinstance(schema_doc, dict):
        raise ValueError("Template schema must be an object.")
    if schema_doc.get("version") != TEMPLATE_SCHEMA_VERSION:
        raise ValueError(
            f"Template schema version must be '{TEMPLATE_SCHEMA_VERSION}', got "
            f"{schema_doc.get('version')!r}."
        )

    blocks = schema_doc.get("blocks")
    if not isinstance(blocks, list):
        raise ValueError("Template schema 'blocks' must be a list.")
    if len(blocks) == 0:
        raise ValueError("Template must have at least one block.")

    seen_ids: set[str] = set()
    for idx, block in enumerate(blocks):
        if not isinstance(block, dict):
            raise ValueError(f"Block at index {idx} must be an object.")

        block_id = block.get("id")
        if not isinstance(block_id, str) or not _BLOCK_ID_RE.match(block_id):
            raise ValueError(
                f"Block at index {idx}: id must match {_BLOCK_ID_RE.pattern} "
                f"(got {block_id!r})."
            )
        if block_id in seen_ids:
            raise ValueError(f"Duplicate block id: {block_id!r}.")
        seen_ids.add(block_id)

        block_type = block.get("type")
        if block_type not in WIDGET_REGISTRY:
            raise ValueError(
                f"Block {block_id!r}: unknown widget type {block_type!r}. "
                f"Known types: {sorted(WIDGET_REGISTRY)}"
            )

        widget = get_widget(block_type)
        props = block.get("props", {})
        if not isinstance(props, dict):
            raise ValueError(f"Block {block_id!r}: props must be an object.")

        try:
            jsonschema.validate(instance=props, schema=widget["props_schema"])
        except jsonschema.ValidationError as exc:
            path = "/".join(str(p) for p in exc.absolute_path)
            where = f"props/{path}" if path else "props"
            raise ValueError(
                f"Block {block_id!r} ({block_type}): {where} — {exc.message}"
            ) from exc

        # Cross-field props checks that JSON Schema can't express cleanly.
        _post_props_checks(block_id, block_type, props)

        # Sanity-check that we can actually derive a content schema (catches
        # bugs in widget builders that only surface on report save otherwise).
        try:
            widget["content_schema_for"](props)
        except Exception as exc:
            raise ValueError(
                f"Block {block_id!r} ({block_type}): cannot derive content "
                f"schema from props — {exc}"
            ) from exc

        # Layout (optional). When absent, the renderer falls back to
        # full-width single-column stacking. When present, validate shape.
        if "layout" in block:
            _validate_layout(block_id, block["layout"])

        # Optional ontology / aggregation metadata. Pure hint layer —
        # presence doesn't affect rendering, only downstream pipelines.
        if "meta" in block:
            _validate_meta(block_id, block["meta"])

    # Cross-block: within each row, sum of col_spans must fit the grid.
    _check_row_col_span_sums(blocks)


def _validate_layout(block_id: str, layout: Any) -> None:
    if not isinstance(layout, dict):
        raise ValueError(f"Block {block_id!r}: layout must be an object.")
    try:
        jsonschema.validate(instance=layout, schema=_LAYOUT_PROPS_SCHEMA)
    except jsonschema.ValidationError as exc:
        path = "/".join(str(p) for p in exc.absolute_path)
        where = f"layout/{path}" if path else "layout"
        raise ValueError(f"Block {block_id!r}: {where} — {exc.message}") from exc


def _validate_meta(block_id: str, meta: Any) -> None:
    if not isinstance(meta, dict):
        raise ValueError(f"Block {block_id!r}: meta must be an object.")
    try:
        jsonschema.validate(instance=meta, schema=META_SCHEMA)
    except jsonschema.ValidationError as exc:
        path = "/".join(str(p) for p in exc.absolute_path)
        where = f"meta/{path}" if path else "meta"
        raise ValueError(f"Block {block_id!r}: {where} — {exc.message}") from exc


def validate_layout_overrides(template_schema: dict, overrides: Any) -> None:
    """Validates a report's layout_overrides against its template.

    Rules:
      - Must be an object whose keys are block ids the template declares.
        (Reports cannot introduce new blocks via this field.)
      - Each value must be a valid layout object: {row, col_span, row_span}.
      - For every row across (template blocks NOT overridden + overridden
        blocks at that row), col_span sum must fit GRID_COLS.

    None / {} → valid (no overrides).
    """
    if overrides is None:
        return
    if not isinstance(overrides, dict):
        raise ValueError("layout_overrides must be an object.")

    if not is_widget_v1(template_schema):
        raise ValueError(
            "Template is not widget-v1; cannot apply layout_overrides."
        )

    template_blocks = template_schema.get("blocks", [])
    valid_ids = {b["id"] for b in template_blocks}

    unknown = set(overrides) - valid_ids
    if unknown:
        raise ValueError(
            f"layout_overrides references unknown block id(s): {sorted(unknown)}. "
            f"Reports cannot add new blocks; only override existing ones."
        )

    for block_id, layout in overrides.items():
        _validate_layout(block_id, layout)

    # Build effective layout (template + overrides) and re-check row sums.
    effective = []
    for b in template_blocks:
        eff = dict(b)
        if b["id"] in overrides:
            eff["layout"] = overrides[b["id"]]
        effective.append(eff)
    _check_row_col_span_sums(effective)


def _check_row_col_span_sums(blocks: list[dict]) -> None:
    """Each grid row's col_span sum must fit in GRID_COLS.

    Blocks with no layout are not constrained — they're rendered in their
    own implicit row. Blocks with explicit layout are bucketed by `row`."""
    sums_by_row: dict[int, int] = {}
    members_by_row: dict[int, list[str]] = {}
    for block in blocks:
        layout = block.get("layout")
        if not isinstance(layout, dict):
            continue
        row = layout.get("row")
        col_span = layout.get("col_span")
        if not isinstance(row, int) or not isinstance(col_span, int):
            # Already caught by per-block validation; skip here.
            continue
        sums_by_row[row] = sums_by_row.get(row, 0) + col_span
        members_by_row.setdefault(row, []).append(block.get("id", "?"))
    for row, total in sums_by_row.items():
        if total > GRID_COLS:
            raise ValueError(
                f"Row {row}: col_span sum is {total} (>{GRID_COLS}). "
                f"Blocks in this row: {members_by_row[row]}"
            )


def _post_props_checks(block_id: str, block_type: str, props: dict) -> None:
    """Cross-field validations that JSON Schema either can't or shouldn't.

    Kept narrow — most invariants belong in props_schema. Only put rules here
    when expressing them as JSON Schema gets ugly.
    """
    if block_type == "key_value":
        for item in props.get("items", []):
            _check_select_has_options(block_id, item, "items")
            _check_field_meta(block_id, item, "items")
        _check_unique_keys(block_id, props.get("items", []), "items")
    elif block_type == "table":
        for col in props.get("columns", []):
            _check_select_has_options(block_id, col, "columns")
            _check_field_meta(block_id, col, "columns")
        _check_unique_keys(block_id, props.get("columns", []), "columns")
    elif block_type == "chart":
        cols = props.get("columns", [])
        _check_unique_keys(block_id, cols, "columns")
        for col in cols:
            _check_field_meta(block_id, col, "columns")
        x_key = props.get("x_column_key")
        col_keys = {c.get("key") for c in cols}
        if x_key not in col_keys:
            raise ValueError(
                f"Block {block_id!r}: x_column_key {x_key!r} is not one of the "
                f"chart's columns ({sorted(col_keys)})."
            )
        # Non-X columns must be numeric so the chart can plot them as series.
        non_x_non_numeric = [
            c.get("key")
            for c in cols
            if c.get("key") != x_key and c.get("type") != "number"
        ]
        if non_x_non_numeric:
            raise ValueError(
                f"Block {block_id!r}: chart series columns must be 'number' "
                f"type. Offending: {non_x_non_numeric}"
            )


def _check_select_has_options(block_id: str, item: dict, where: str) -> None:
    if item.get("type") == "select" and not (item.get("options") or []):
        raise ValueError(
            f"Block {block_id!r}: {where} item {item.get('key')!r} is a "
            f"'select' but has no options."
        )


def _check_field_meta(block_id: str, item: dict, where: str) -> None:
    """Validate the optional `meta` block on a key_value item / table column /
    chart column. The widget's own props_schema only checks that meta is an
    object — the actual ontology shape lives in META_SCHEMA, kept in this
    module to avoid a circular import with registry.py."""
    meta = item.get("meta")
    if meta is None:
        return
    if not isinstance(meta, dict):
        raise ValueError(
            f"Block {block_id!r}: {where} item {item.get('key')!r} meta must be an object."
        )
    try:
        jsonschema.validate(instance=meta, schema=META_SCHEMA)
    except jsonschema.ValidationError as exc:
        path = "/".join(str(p) for p in exc.absolute_path)
        where_str = f"{where}/{item.get('key')!r}/meta"
        if path:
            where_str = f"{where_str}/{path}"
        raise ValueError(f"Block {block_id!r}: {where_str} — {exc.message}") from exc


def _check_unique_keys(block_id: str, items: list[dict], where: str) -> None:
    seen: set[str] = set()
    for item in items:
        key = item.get("key")
        if key in seen:
            raise ValueError(
                f"Block {block_id!r}: duplicate key {key!r} in {where}."
            )
        seen.add(key)


# --------------------------------------------------------------------------- #
# Report content validation
# --------------------------------------------------------------------------- #
def validate_report_content(
    template_schema: dict,
    content: dict,
    extra_blocks: Optional[list[dict]] = None,
) -> None:
    """Validates a report's content against a widget-v1 template plus any
    extra blocks the report added at write time.

    Partial drafts are allowed: missing block_ids are skipped. But any
    block_id that *is* present must satisfy its widget's content schema,
    and any extra keys in content (not declared by either the template
    or the page's extra_blocks list) are rejected.
    """
    if not is_widget_v1(template_schema):
        raise ValueError(
            "Template is not widget-v1; cannot validate content with the widget registry."
        )
    if not isinstance(content, dict):
        raise ValueError("Report content must be an object.")

    template_blocks = {b["id"]: b for b in template_schema.get("blocks", [])}
    extra = extra_blocks or []
    _validate_extra_blocks_shape(extra, reserved_ids=set(template_blocks))
    extra_by_id = {b["id"]: b for b in extra}

    blocks_by_id = {**template_blocks, **extra_by_id}

    unknown = set(content) - set(blocks_by_id)
    if unknown:
        raise ValueError(
            f"Report content has unknown block ids not in the template or extra blocks: "
            f"{sorted(unknown)}"
        )

    for block_id, block in blocks_by_id.items():
        if block_id not in content:
            continue  # partial draft — skip
        widget = get_widget(block["type"])
        if not widget["has_content"]:
            raise ValueError(
                f"Block {block_id!r} ({block['type']}) has no content slot but "
                f"content was provided."
            )
        content_schema = widget["content_schema_for"](block.get("props", {}))
        try:
            jsonschema.validate(instance=content[block_id], schema=content_schema)
        except jsonschema.ValidationError as exc:
            path = "/".join(str(p) for p in exc.absolute_path)
            where = f"{block_id}/{path}" if path else block_id
            raise ValueError(f"Content invalid at {where}: {exc.message}") from exc


def _validate_extra_blocks_shape(extra_blocks: list[dict], reserved_ids: set) -> None:
    """Per-page extra block sanity check — type known to the registry, ids
    unique within the page, and no collisions with the template's block ids
    (template wins, extras can't shadow)."""
    seen: set[str] = set()
    for block in extra_blocks:
        if not isinstance(block, dict):
            raise ValueError("Each extra block must be an object.")
        block_id = block.get("id")
        if not isinstance(block_id, str) or not block_id:
            raise ValueError("Extra block missing a string `id`.")
        if block_id in reserved_ids:
            raise ValueError(
                f"Extra block id {block_id!r} collides with a template block id."
            )
        if block_id in seen:
            raise ValueError(f"Duplicate extra block id {block_id!r}.")
        seen.add(block_id)
        type_ = block.get("type")
        if not isinstance(type_, str) or not type_:
            raise ValueError(f"Extra block {block_id!r} missing a string `type`.")
        # Triggers KeyError → caller surfaces as a 400.
        get_widget(type_)
