"""Visibility tests for templates with the multi-slug owner field.

Exercises both the SQL-side filter (`list_templates`) and the in-memory
check (`is_visible`). The seed already creates the workspace tree we rely on:
  dev (root)
    ├ dev-platform
    ├ dev-product
    ├ dev-data
    └ dev-devops
  biz (root)
    ├ biz-sales
    └ biz-marketing
"""
import uuid

import pytest
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.modules.templates import services
from app.modules.templates.models import Template


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


def _make_template(db: Session, slugs):
    """Create a minimal template with the given owner slugs and clean it up
    via the test fixture's rollback."""
    schema = {
        "version": "widget-v1",
        "blocks": [
            {"id": "summary", "type": "rich_text", "props": {"label": "요약"}},
        ],
    }
    t = Template(
        template_id=f"test-{uuid.uuid4().hex[:8]}",
        version=1,
        name="t",
        description="",
        category="misc",
        schema=schema,
        owner_workspace_slugs=slugs,
        is_published=True,
        is_latest=True,
        created_by_user_id=None,
    )
    db.add(t)
    db.flush()
    return t


def test_global_template_visible_everywhere(db):
    t = _make_template(db, None)
    assert services.is_visible(db, t, "dev") is True
    assert services.is_visible(db, t, "biz-sales") is True


def test_empty_array_treated_as_global(db):
    t = _make_template(db, [])
    assert services.is_visible(db, t, "dev") is True
    assert services.is_visible(db, t, "biz") is True


def test_single_slug_visible_in_tree(db):
    t = _make_template(db, ["dev"])
    # dev itself + descendants
    assert services.is_visible(db, t, "dev") is True
    assert services.is_visible(db, t, "dev-platform") is True
    # ancestors don't apply since dev has no parent
    # other tree
    assert services.is_visible(db, t, "biz") is False
    assert services.is_visible(db, t, "biz-sales") is False


def test_multi_slug_visible_in_either_tree(db):
    t = _make_template(db, ["dev-platform", "biz-sales"])
    assert services.is_visible(db, t, "dev-platform") is True
    assert services.is_visible(db, t, "dev") is True  # ancestor
    assert services.is_visible(db, t, "biz-sales") is True
    assert services.is_visible(db, t, "biz-marketing") is False  # sibling, not in either set


def test_list_templates_filters_by_visibility(db):
    # Seed three templates with different visibility:
    only_dev = _make_template(db, ["dev"])
    only_biz = _make_template(db, ["biz"])
    glob = _make_template(db, None)

    visible_to_dev = services.list_templates(db, "dev", only_latest=True)
    ids = {t.template_id for t in visible_to_dev}
    assert only_dev.template_id in ids
    assert glob.template_id in ids
    assert only_biz.template_id not in ids

    visible_to_biz = services.list_templates(db, "biz-sales", only_latest=True)
    ids = {t.template_id for t in visible_to_biz}
    assert only_biz.template_id in ids
    assert glob.template_id in ids
    assert only_dev.template_id not in ids


def test_normalize_owner_slugs_dedupes_and_drops_blanks():
    fn = services._normalize_owner_slugs
    assert fn(None) is None
    assert fn([]) is None
    assert fn(["", "  "]) is None
    assert fn(["dev", "dev"]) == ["dev"]
    assert fn(["dev", "biz", "dev"]) == ["dev", "biz"]  # order preserved
