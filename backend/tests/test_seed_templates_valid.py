"""Sanity check: every seeded template is a valid widget-v1 schema.

A seed bug that produces an invalid template would make the seed script
fail mid-run on any DB that's already been bootstrapped, leaving the seed
in a half-applied state. Better to catch it here.
"""
from app.widgets import validate_template_schema
from scripts.seed_initial_data import TEMPLATES, _make_schema


def test_every_seed_template_is_valid_widget_v1():
    for spec in TEMPLATES:
        schema = _make_schema(spec["blocks"])
        try:
            validate_template_schema(schema)
        except ValueError as exc:
            raise AssertionError(
                f"Seed template {spec['template_id']!r} is invalid: {exc}"
            ) from exc
