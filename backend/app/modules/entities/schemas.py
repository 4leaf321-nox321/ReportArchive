"""Pydantic schemas for the entity tagging module."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.entities.models import EntityStatus


class EntityTypeRead(BaseModel):
    """One axis — system-managed, returned as a flat list from
    `/api/entity-types` so the picker can render one section per axis."""

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
