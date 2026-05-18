"""Pydantic schemas for reports."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.reports.models import ReportStatus


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
    period: str
    owner_user_id: Optional[int]
    tags: list[str]
    content: dict
    layout_overrides: Optional[dict] = None
    props_overrides: Optional[dict] = None
    pages: list[ReportPage] = []
    created_at: datetime
    updated_at: datetime


class ReportSummary(BaseModel):
    """Lightweight version for list endpoints — content omitted."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    workspace_slug: str
    template_id: str
    template_version: int
    title: str
    status: ReportStatus
    period: str
    owner_user_id: Optional[int]
    tags: list[str]
    created_at: datetime
    updated_at: datetime


class ReportCreate(BaseModel):
    # Primary template — required and mirrored into pages[0] when `pages`
    # isn't supplied. When `pages` is supplied, page 0 must match these.
    template_id: str = Field(..., min_length=1, max_length=64)
    template_version: int = Field(..., ge=1)
    title: str = Field(..., min_length=1, max_length=255)
    period: str = ""
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
    period: Optional[str] = None
    tags: Optional[list[str]] = None
    # Legacy single-page fields — when supplied, applied to page 0 (and the
    # rest of the pages stay untouched). Frontend multi-page clients should
    # send `pages` instead.
    content: Optional[dict] = None
    layout_overrides: Optional[dict] = None
    props_overrides: Optional[dict] = None
    pages: Optional[list[ReportPage]] = None
