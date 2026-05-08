"""Pydantic schemas for reports."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.reports.models import ReportStatus


class ReportRead(BaseModel):
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
    content: dict
    # Per-report layout overrides keyed by block id. When absent, template's
    # layout is used. Reports may resize/reposition existing blocks but not
    # add or remove them.
    layout_overrides: Optional[dict] = None
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
    template_id: str = Field(..., min_length=1, max_length=64)
    template_version: int = Field(..., ge=1)
    title: str = Field(..., min_length=1, max_length=255)
    period: str = ""
    tags: list[str] = []
    content: dict = {}
    layout_overrides: Optional[dict] = None


class ReportUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    status: Optional[ReportStatus] = None
    period: Optional[str] = None
    tags: Optional[list[str]] = None
    content: Optional[dict] = None
    layout_overrides: Optional[dict] = None
