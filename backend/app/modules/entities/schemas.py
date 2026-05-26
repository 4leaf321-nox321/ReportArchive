"""Pydantic schemas for the entity tagging module."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.entities.models import EntityStatus


class EntityTypeRead(BaseModel):
    """One axis — picker reads a flat list from `/api/entity-types`."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    slug: str
    label: str
    icon: str
    multi: bool
    sort_order: int
    description: str


class EntityTypeListResponse(BaseModel):
    items: list[EntityTypeRead]


class EntityTypeCreate(BaseModel):
    """Admin-only — add a new axis. `slug` is the stable identifier; the
    service layer normalizes it (lowercase, strip) and rejects clashes
    against the existing axes. `sort_order` defaults to the end of the
    list when omitted, so newly added axes land at the right side of the
    tab strip without the admin having to compute the next index."""

    slug: str = Field(..., min_length=1, max_length=32)
    label: str = Field(..., min_length=1, max_length=64)
    icon: str = Field(default="", max_length=32)
    multi: bool = True
    sort_order: Optional[int] = Field(default=None, ge=0, le=10_000)
    description: str = Field(default="", max_length=2000)


class EntityRead(BaseModel):
    """One value. `type_slug` is denormalized so the frontend doesn't
    need a second lookup to know which axis a value belongs to —
    matches how `report_type` is flattened on Report responses."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    type_id: int
    type_slug: str
    value: str
    code: Optional[str] = None
    description: str
    status: EntityStatus
    created_by_user_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime
    # 관리 페이지에서만 채움 (admin route 가 with_usage=True 로 호출).
    # picker 경로에서는 None — 매 행마다 COUNT 서브쿼리를 돌리는 비용을
    # 의도적으로 회피. 화면에 "사용 중인 보고서 N건" 으로 노출.
    usage_count: Optional[int] = None


class EntityRefMini(BaseModel):
    """Slim form embedded inside `ReportRead.entities` — only the fields
    a list/detail page needs to render chips, without the audit columns."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    type_id: int
    type_slug: str
    value: str
    code: Optional[str] = None
    status: EntityStatus


class EntityListResponse(BaseModel):
    items: list[EntityRead]


class EntityCreate(BaseModel):
    type_id: int
    value: str = Field(..., min_length=1, max_length=255)
    code: Optional[str] = Field(default=None, max_length=64)
    description: str = Field(default="", max_length=2000)


class EntityUpdate(BaseModel):
    """Admin-only edits. `value` rename is allowed but a clash check
    runs in the service layer. `status` is the deprecate/restore toggle."""

    value: Optional[str] = Field(default=None, min_length=1, max_length=255)
    code: Optional[str] = Field(default=None, max_length=64)
    description: Optional[str] = Field(default=None, max_length=2000)
    status: Optional[EntityStatus] = None


class EntityMergeRequest(BaseModel):
    """Re-link all reports from `src` to `into`, then delete `src`. Both
    must be on the same axis — enforced by the service."""

    into_id: int


class EntityUsageReportRef(BaseModel):
    """Slim ref to a report tagged with an entity. Used by the admin
    page's "어떤 보고서가 막고 있나?" lookups — populated by
    /api/entities/{id}/usage. Only the fields needed to render a list
    row + navigate are included; full report fetch is one click away."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    workspace_slug: str
    updated_at: datetime


class EntityUsageResponse(BaseModel):
    items: list[EntityUsageReportRef]
