"""Pydantic schemas for report types."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.report_types.models import ReportTypeStatus


class _UserMini(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: str


class ReportTypeRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str
    status: ReportTypeStatus
    created_by: Optional[_UserMini] = None
    approved_by: Optional[_UserMini] = None
    created_at: datetime
    updated_at: datetime
    approved_at: Optional[datetime] = None


class ReportTypeCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    description: str = Field(default="", max_length=2000)
    # Admin-only — if set to "official" by a non-admin, the route layer
    # downgrades it to unofficial. Default is None which means "let the
    # service pick the right status for the caller's role".
    status: Optional[ReportTypeStatus] = None


class ReportTypeUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=128)
    description: Optional[str] = Field(default=None, max_length=2000)


class ReportTypeListResponse(BaseModel):
    items: list[ReportTypeRead]
