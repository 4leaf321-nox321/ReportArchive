"""Pydantic schemas for files."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class FileFromUrlRequest(BaseModel):
    """링크 방식(URL 인제스트) 요청 — 서버가 이 URL 에서 파일을 받아 저장한다."""

    url: str = Field(..., min_length=1, max_length=2048)
    # 저장할 파일명(선택). 없으면 URL/Content-Type 에서 유추.
    filename: Optional[str] = Field(default=None, max_length=255)


class FileMeta(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    filename: str
    mime_type: str
    size: int
    is_image: bool
    owner_user_id: int | None
    workspace_slug: str
    uploaded_at: datetime


class BulkDeleteFilesRequest(BaseModel):
    """부서 파일 일괄 삭제 — 지울 file_id 목록."""

    file_ids: list[str] = Field(..., min_length=1)


class ReassignFilesRequest(BaseModel):
    """부서 파일 이관 — 대상 부서로 workspace_slug 변경."""

    file_ids: list[str] = Field(..., min_length=1)
    target_slug: str = Field(..., min_length=1, max_length=64)
