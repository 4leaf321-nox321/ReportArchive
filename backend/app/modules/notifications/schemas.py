"""Pydantic schemas for notifications."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict

from app.modules.notifications.models import NotificationType
from app.shared.datetime_utils import UtcDatetime


class NotificationActor(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: str


class NotificationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    recipient_user_id: int
    actor: Optional[NotificationActor] = None
    type: NotificationType
    ref_table: Optional[str] = None
    ref_id: Optional[int] = None
    workspace_slug: Optional[str] = None
    payload: dict
    created_at: UtcDatetime
    read_at: Optional[UtcDatetime] = None


class NotificationListResponse(BaseModel):
    items: list[NotificationRead]
    unread_count: int


class UnreadCountResponse(BaseModel):
    unread_count: int
