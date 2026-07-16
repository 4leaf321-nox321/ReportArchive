"""Pydantic schemas for the notice board."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.shared.datetime_utils import UtcDatetime


class _UserMini(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    email: str


class NoticeAttachment(BaseModel):
    """One uploaded image on a notice. file_id is the /api/files
    identifier; filename + size + mime_type let the UI render without an
    extra metadata round-trip."""

    file_id: str = Field(..., min_length=1, max_length=64)
    filename: str = Field(..., min_length=1, max_length=255)
    size: int = Field(default=0, ge=0)
    mime_type: str = Field(default="", max_length=128)


class NoticePostRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    title: str
    body: str
    pinned: bool
    author: Optional[_UserMini]
    attachments: list[NoticeAttachment] = Field(default_factory=list)
    created_at: UtcDatetime
    updated_at: UtcDatetime


class NoticePostListResponse(BaseModel):
    """Server-paginated list. `items` is the current page, `total` lets
    the client render 「N건 중 M번」 or compute a page count."""

    items: list[NoticePostRead] = Field(default_factory=list)
    total: int = 0
    limit: int = 0
    offset: int = 0


class NoticePostCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    # 본문은 리치 텍스트 HTML(문단·서식·인라인 이미지 참조). 이미지는 파일 id
    # 참조라 크기가 작지만, 마크업 여유를 위해 상한을 넉넉히 둔다.
    body: str = Field(default="", max_length=200000)
    pinned: bool = False
    attachments: list[NoticeAttachment] = Field(default_factory=list)


class NoticePostUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    body: Optional[str] = Field(default=None, max_length=200000)
    pinned: Optional[bool] = None
    attachments: Optional[list[NoticeAttachment]] = None


class NoticePopupSeen(BaseModel):
    """사용자가 팝업으로 확인한 공지 id. 이 값 이하의 공지는 더 팝업되지 않는다."""

    notice_id: int = Field(..., ge=1)
