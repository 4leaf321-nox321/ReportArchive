"""Widget registry — catalog of UI widgets that templates compose.

A widget-v1 template is an ordered list of widget *instances*, each
configured with props. A report fills in the content slot of each
instance, keyed by block id.

Each widget defines:
  - props_schema: JSON Schema validated at template save time
  - content_schema_for(props): JSON Schema for the content slot, possibly
    derived from configured props (e.g., a `table`'s content schema depends
    on the columns defined in props). Returns None for purely presentational
    widgets like `heading`.
  - has_content: False for widgets that contribute no data to the report
"""
from app.widgets.registry import WIDGET_REGISTRY, get_widget, list_widget_descriptors
from app.widgets.validation import (
    TEMPLATE_SCHEMA_VERSION,
    is_widget_v1,
    validate_layout_overrides,
    validate_report_content,
    validate_template_schema,
)

__all__ = [
    "TEMPLATE_SCHEMA_VERSION",
    "WIDGET_REGISTRY",
    "get_widget",
    "is_widget_v1",
    "list_widget_descriptors",
    "validate_layout_overrides",
    "validate_report_content",
    "validate_template_schema",
]
