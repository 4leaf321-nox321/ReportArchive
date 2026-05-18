"""Pydantic schemas for reports."""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.modules.reports.models import ReportStatus


def _flatten_user_refs(obj: Any) -> Any:
    """Pre-validator that copies joined user info from the ORM model into
    flat string fields so frontend consumers don't need a second lookup.
    Idempotent for dict inputs (used by JSON round-trips) — only walks the
    relationship attributes when given an ORM Report.
    """
    if obj is None or isinstance(obj, dict):
        return obj
    extras: dict[str, Any] = {}
    owner = getattr(obj, "owner", None)
    if owner is not None:
        extras["owner_name"] = owner.name
        extras["owner_email"] = owner.email
    updated_by = getattr(obj, "updated_by", None)
    if updated_by is not None:
        extras["updated_by_name"] = updated_by.name
        extras["updated_by_email"] = updated_by.email
    if not extras:
        return obj
    # Build a dict so Pydantic stops walking the ORM (otherwise it'd try to
    # find owner_name as an attribute on the row and fail). We carry every
    # field through that the consumer schemas declare; the rest get the
    # default from_attributes pull via __dict__.
    base: dict[str, Any] = {
        key: getattr(obj, key)
        for key in (
            "id", "workspace_slug", "template_id", "template_version",
            "title", "status", "report_date",
            "owner_user_id", "updated_by_user_id",
            "tags", "content", "layout_overrides", "props_overrides", "pages",
            "created_at", "updated_at",
        )
        if hasattr(obj, key)
    }
    base.update(extras)
    return base


class ReportPage(BaseModel):
    """A single page within a report.

    Each page binds to its own template version so a report can mix
    different layouts (e.g. cover page + detail pages + appendix). The
    very first page's template is mirrored into the report's top-level
    `template_id` / `template_version` columns to keep the FK constraint
    + list-view fields meaningful.
    """

    template_id: str = Field(..., min_length=1, max_length=64)
    template_version: int = Field(..., ge=1)
    # Per-page display name (shown in the page strip). When unset, the
    # frontend falls back to the page's template name. The overall report
    # title is the separate `Report.title` column.
    name: Optional[str] = Field(default=None, max_length=120)
    content: dict = {}
    layout_overrides: Optional[dict] = None
    # Visual-style overrides keyed by block id, e.g.
    #   { "<block_id>": { "text_style": {...}, "depth_styles": {...} } }
    # Whitelisted by the service layer to {text_style, depth_styles} —
    # structural props (items, min_length, ...) stay locked because the
    # content schema is derived from them.
    props_overrides: Optional[dict] = None


class ReportRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    workspace_slug: str
    # Top-level template/content/layout_overrides reflect *page 0* — kept
    # for backward-compat with existing API consumers and to satisfy the
    # composite FK. Multi-page consumers should read `pages` instead.
    template_id: str
    template_version: int
    title: str
    status: ReportStatus
    report_date: date
    owner_user_id: Optional[int]
    # Joined display fields — flattened so the frontend doesn't need a
    # separate /api/users lookup for every report row. workspace_slug above
    # doubles as "작성자가 작성 시점에 속해 있던 부서" (no separate snapshot
    # column because reports don't currently move between workspaces).
    owner_name: Optional[str] = None
    owner_email: Optional[str] = None
    updated_by_user_id: Optional[int] = None
    updated_by_name: Optional[str] = None
    updated_by_email: Optional[str] = None
    tags: list[str]
    content: dict
    layout_overrides: Optional[dict] = None
    props_overrides: Optional[dict] = None
    pages: list[ReportPage] = []
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, obj: Any) -> Any:
        return _flatten_user_refs(obj)


class ReportPagePreview(BaseModel):
    """Slim per-page entry shipped with list responses so the templates
    column can show every page's binding, not just page 0. content +
    overrides are deliberately omitted to keep the list payload light."""

    model_config = ConfigDict(extra="ignore")

    template_id: str
    template_version: int
    name: Optional[str] = None


class ReportSummary(BaseModel):
    """Lightweight version for list endpoints — content omitted."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    workspace_slug: str
    template_id: str
    template_version: int
    title: str
    status: ReportStatus
    report_date: date
    owner_user_id: Optional[int]
    owner_name: Optional[str] = None
    owner_email: Optional[str] = None
    updated_by_user_id: Optional[int] = None
    updated_by_name: Optional[str] = None
    updated_by_email: Optional[str] = None
    tags: list[str]
    # Per-page template bindings. Pydantic pulls this from the JSONB
    # `pages` column and discards the heavy fields (content, layouts)
    # via ReportPagePreview's extra="ignore".
    pages: list[ReportPagePreview] = []
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, obj: Any) -> Any:
        return _flatten_user_refs(obj)


class ReportCreate(BaseModel):
    # Primary template — required and mirrored into pages[0] when `pages`
    # isn't supplied. When `pages` is supplied, page 0 must match these.
    template_id: str = Field(..., min_length=1, max_length=64)
    template_version: int = Field(..., ge=1)
    title: str = Field(..., min_length=1, max_length=255)
    # Aggregation reference date. Omit to default to today on the server.
    report_date: Optional[date] = None
    # Work-state status. Omit to land in `draft` (작성 중).
    status: Optional[ReportStatus] = None
    tags: list[str] = []
    # Legacy single-page fields — applied to page 0 when `pages` is None.
    content: dict = {}
    layout_overrides: Optional[dict] = None
    props_overrides: Optional[dict] = None
    # New multi-page payload. When provided, takes precedence over the
    # legacy single-page fields.
    pages: Optional[list[ReportPage]] = None


class ReportUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    status: Optional[ReportStatus] = None
    report_date: Optional[date] = None
    tags: Optional[list[str]] = None
    # Legacy single-page fields — when supplied, applied to page 0 (and the
    # rest of the pages stay untouched). Frontend multi-page clients should
    # send `pages` instead.
    content: Optional[dict] = None
    layout_overrides: Optional[dict] = None
    props_overrides: Optional[dict] = None
    pages: Optional[list[ReportPage]] = None
