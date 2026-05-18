"""Business logic for reports — workspace scoping + widget-v1 validation."""
from __future__ import annotations

from typing import Iterable, Optional

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.modules.reports.models import Report
from app.modules.reports.schemas import ReportCreate, ReportPage, ReportUpdate
from app.modules.templates import services as template_services
from app.modules.workspaces import services as ws_services
from app.widgets import (
    validate_layout_overrides as _validate_layout_overrides,
    validate_report_content as _validate_widget_v1_content,
)


def list_reports_in_workspace(
    db: Session,
    workspace_slug: str,
    *,
    is_global_view: bool = False,
) -> list[Report]:
    """Returns reports scoped to the workspace tree.

    For non-leaf workspaces, this includes all descendants. The virtual
    `_global` workspace bypasses scoping (admin/横断 view).
    """
    query = select(Report).order_by(desc(Report.updated_at))
    if not is_global_view:
        scope = ws_services.get_descendants_inclusive(db, workspace_slug)
        query = query.where(Report.workspace_slug.in_(scope))
    return list(db.execute(query).scalars())


def get_report(db: Session, report_id: int) -> Optional[Report]:
    return db.get(Report, report_id)


def is_visible_to(db: Session, report: Report, workspace_slug: str) -> bool:
    """Workspace tree visibility check — actor's workspace must be an ancestor
    of the report's workspace (or the same)."""
    scope = ws_services.get_descendants_inclusive(db, workspace_slug)
    return report.workspace_slug in scope


def _validate_page(db: Session, page: ReportPage) -> None:
    """Validate a single page's content + layout against its own template
    plus any per-page extra blocks the report added."""
    template = template_services.get_template(db, page.template_id, page.template_version)
    if not template:
        raise ValueError(
            f"Template not found: {page.template_id}@{page.template_version}"
        )
    if page.content:
        _validate_widget_v1_content(
            template.schema, page.content, extra_blocks=page.extra_blocks
        )
    if page.layout_overrides:
        # Layout overrides may reference extra-block ids too; pass them
        # through as a synthetic schema so the validator accepts them.
        combined = _schema_with_extras(template.schema, page.extra_blocks)
        _validate_layout_overrides(combined, page.layout_overrides)


def _schema_with_extras(template_schema: dict, extra_blocks: list[dict]) -> dict:
    """Returns a synthetic widget-v1 schema with the template's blocks +
    the page's extra_blocks. Used by validators that only know how to look
    up blocks by id on a single schema document."""
    if not extra_blocks:
        return template_schema
    return {
        **template_schema,
        "blocks": [*template_schema.get("blocks", []), *extra_blocks],
    }


def _validate_pages(db: Session, pages: Iterable[ReportPage]) -> None:
    pages = list(pages)
    if not pages:
        raise ValueError("Report must have at least one page")
    for page in pages:
        _validate_page(db, page)


def _normalize_overrides(overrides: dict | None) -> dict | None:
    """Treat empty dicts as None so the DB stays clean."""
    if not overrides:
        return None
    return overrides


# Per-report props can only override a small set of visual-style keys.
# Anything else (items, min_length, required, etc.) is silently dropped
# because the content schema is derived from those — overriding them on
# a report would invalidate existing content.
_ALLOWED_OVERRIDE_KEYS = ("text_style", "depth_styles")


def _sanitize_props_overrides(overrides: dict | None) -> dict | None:
    """Strip non-whitelisted keys and prune empties.

    Shape in: { "<block_id>": { any keys }, ... }
    Shape out: { "<block_id>": { "text_style": {...} | "depth_styles": {...} } }
    Blocks that end up with no whitelisted keys are dropped entirely.
    """
    if not overrides or not isinstance(overrides, dict):
        return None
    out: dict[str, dict] = {}
    for block_id, raw in overrides.items():
        if not isinstance(block_id, str) or not isinstance(raw, dict):
            continue
        cleaned: dict = {}
        for key in _ALLOWED_OVERRIDE_KEYS:
            value = raw.get(key)
            if value in (None, "", {}, []):
                continue
            cleaned[key] = value
        if cleaned:
            out[block_id] = cleaned
    return out or None


def _pages_to_jsonb(pages: list[ReportPage]) -> list[dict]:
    """Serialize ReportPage list into the JSONB shape stored on `Report.pages`.
    Empty `layout_overrides` is normalized to None to match the single-page
    column's convention."""
    return [
        {
            "template_id": p.template_id,
            "template_version": p.template_version,
            "name": (p.name or None),
            "content": p.content or {},
            "layout_overrides": _normalize_overrides(p.layout_overrides),
            "props_overrides": _sanitize_props_overrides(p.props_overrides),
            "extra_blocks": list(p.extra_blocks or []),
        }
        for p in pages
    ]


def _resolve_pages_for_create(payload: ReportCreate) -> list[ReportPage]:
    """Build the canonical page list for a create payload.

    If the client sent `pages`, use it verbatim (but enforce page 0 matches
    the top-level template — they're meant to be in sync). Otherwise
    synthesize a single page from the legacy single-template fields.
    """
    if payload.pages is not None:
        if not payload.pages:
            raise ValueError("`pages` cannot be empty")
        first = payload.pages[0]
        if (
            first.template_id != payload.template_id
            or first.template_version != payload.template_version
        ):
            raise ValueError(
                "pages[0] template must match the report's top-level template"
            )
        return list(payload.pages)
    return [
        ReportPage(
            template_id=payload.template_id,
            template_version=payload.template_version,
            content=payload.content or {},
            layout_overrides=payload.layout_overrides,
            props_overrides=payload.props_overrides,
        )
    ]


def create_report(
    db: Session,
    workspace_slug: str,
    payload: ReportCreate,
    owner_user_id: int,
) -> Report:
    pages = _resolve_pages_for_create(payload)
    _validate_pages(db, pages)

    page0 = pages[0]
    init_kwargs: dict = dict(
        workspace_slug=workspace_slug,
        template_id=page0.template_id,
        template_version=page0.template_version,
        title=payload.title,
        tags=list(payload.tags or []),
    )
    # Only pass report_date when the client explicitly supplied one;
    # leaving it out lets the column's CURRENT_DATE default fill in.
    if payload.report_date is not None:
        init_kwargs["report_date"] = payload.report_date
    if payload.status is not None:
        init_kwargs["status"] = payload.status
    report = Report(
        **init_kwargs,
        content=page0.content or {},
        layout_overrides=_normalize_overrides(page0.layout_overrides),
        props_overrides=_sanitize_props_overrides(page0.props_overrides),
        pages=_pages_to_jsonb(pages),
        owner_user_id=owner_user_id,
        # On a fresh report the creator is also the last editor — keeps
        # the column non-null so the UI never has to render "수정인: —"
        # for never-edited rows.
        updated_by_user_id=owner_user_id,
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


def update_report(
    db: Session,
    report: Report,
    payload: ReportUpdate,
    *,
    updated_by_user_id: Optional[int] = None,
) -> Report:
    data = payload.model_dump(exclude_unset=True)

    # Resolve the new page list. Either the client sent the full `pages`
    # array (multi-page-aware), or they sent the legacy single-page
    # content / layout_overrides which we apply to page 0 in place.
    new_pages: Optional[list[ReportPage]] = None
    if "pages" in data:
        if not payload.pages:
            raise ValueError("`pages` cannot be empty")
        new_pages = list(payload.pages)
    elif "content" in data or "layout_overrides" in data or "props_overrides" in data:
        existing = list(report.pages or [])
        if not existing:
            # Defensive: should never happen post-migration, but keep
            # legacy updates working even on rows that pre-date it.
            existing = [
                {
                    "template_id": report.template_id,
                    "template_version": report.template_version,
                    "content": report.content or {},
                    "layout_overrides": report.layout_overrides,
                    "props_overrides": report.props_overrides,
                }
            ]
        # Mutate page 0 from legacy fields.
        page0 = dict(existing[0])
        if "content" in data:
            page0["content"] = data["content"] or {}
        if "layout_overrides" in data:
            page0["layout_overrides"] = _normalize_overrides(data["layout_overrides"])
        if "props_overrides" in data:
            page0["props_overrides"] = _sanitize_props_overrides(data["props_overrides"])
        existing[0] = page0
        new_pages = [ReportPage(**p) for p in existing]

    if new_pages is not None:
        _validate_pages(db, new_pages)
        page0 = new_pages[0]
        report.template_id = page0.template_id
        report.template_version = page0.template_version
        report.content = page0.content or {}
        report.layout_overrides = _normalize_overrides(page0.layout_overrides)
        report.props_overrides = _sanitize_props_overrides(page0.props_overrides)
        report.pages = _pages_to_jsonb(new_pages)

    # Apply non-page scalar fields.
    for key in ("title", "status", "report_date", "tags"):
        if key in data:
            setattr(report, key, data[key])

    # Stamp the last-editor. Done on every successful update path; routes
    # always pass the actor id so this never silently goes None.
    if updated_by_user_id is not None:
        report.updated_by_user_id = updated_by_user_id

    db.commit()
    db.refresh(report)
    return report


def delete_report(db: Session, report: Report) -> None:
    db.delete(report)
    db.commit()
