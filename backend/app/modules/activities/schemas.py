"""Pydantic schemas for activities — read-only API for the timeline UI."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict

from app.modules.activities.models import ReportActivityType
from app.shared.datetime_utils import UtcDatetime


class ActivityActorMini(BaseModel):
    """Slim actor info — name + email for display."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    name: str


class ActivityRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    report_id: int
    actor: Optional[ActivityActorMini] = None
    type: ReportActivityType
    payload: dict
    created_at: UtcDatetime


class ActivityListResponse(BaseModel):
    items: list[ActivityRead]
