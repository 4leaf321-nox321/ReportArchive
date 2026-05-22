"""Pydantic schemas for the VOC board."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.voc.models import VocCategory, VocPriority, VocStatus


class _UserMini(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    email: str


class VocCommentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    post_id: int
    body: str
    author: Optional[_UserMini]
    created_at: datetime
    updated_at: datetime


class VocAttachment(BaseModel):
    """One uploaded screenshot / image on a post. file_id is the
    /api/files identifier; filename + size + mime_type are surfaced for
    the UI without an extra metadata round-trip."""

    file_id: str = Field(..., min_length=1, max_length=64)
    filename: str = Field(..., min_length=1, max_length=255)
    size: int = Field(default=0, ge=0)
    mime_type: str = Field(default="", max_length=128)


class VocPostRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    title: str
    body: str
    category: VocCategory
    status: VocStatus
    priority: VocPriority
    author: Optional[_UserMini]
    workspace_slug: Optional[str]
    attachments: list[VocAttachment] = Field(default_factory=list)
    comment_count: int = 0
    created_at: datetime
    updated_at: datetime
    resolved_at: Optional[datetime]


class VocPostDetail(VocPostRead):
    comments: list[VocCommentRead] = Field(default_factory=list)


class VocPostListResponse(BaseModel):
    """Server-paginated list. `items` is the current page, `total` lets
    the client render a 「N건 중 M번」 hint or compute a page count."""

    items: list[VocPostRead] = Field(default_factory=list)
    total: int = 0
    limit: int = 0
    offset: int = 0


class VocPostCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    body: str = Field(default="", max_length=20000)
    category: VocCategory = VocCategory.question
    workspace_slug: Optional[str] = None
    attachments: list[VocAttachment] = Field(default_factory=list)


class VocPostUpdate(BaseModel):
    """Author-editable fields. `status` / `priority` go through their own
    admin-only endpoints (different permission)."""

    model_config = ConfigDict(extra="forbid")

    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    body: Optional[str] = Field(default=None, max_length=20000)
    category: Optional[VocCategory] = None
    attachments: Optional[list[VocAttachment]] = None


class VocPostStatusUpdate(BaseModel):
    status: VocStatus


class VocPostPriorityUpdate(BaseModel):
    priority: VocPriority


class VocCommentCreate(BaseModel):
    body: str = Field(..., min_length=1, max_length=10000)


class VocCommentUpdate(BaseModel):
    body: str = Field(..., min_length=1, max_length=10000)
