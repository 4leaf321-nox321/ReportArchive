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


class WorkspaceActivityRead(BaseModel):
    """부서 홈 활동 피드 1행. 보고서별 타임라인(ActivityRead)과 달리
    어느 보고서의 사건인지 알아야 하므로 report_title 을 함께 싣는다."""

    id: int
    report_id: int
    report_title: str
    actor: Optional[ActivityActorMini] = None
    type: ReportActivityType
    payload: dict
    created_at: UtcDatetime


class WorkspaceActivityListResponse(BaseModel):
    items: list[WorkspaceActivityRead]
