"""Pydantic schemas for folders (personal + org)."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.folders.models import FolderKind


class FolderRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: FolderKind
    user_id: Optional[int] = None
    workspace_slug: Optional[str] = None
    parent_id: Optional[int]
    name: str
    sort_order: int
    # 조직 간 공개 3-state override(조직간공개_설계.md §4.2). NULL=게시판 기본
    # 상속, TRUE=공개, FALSE=비공개. org 폴더에만 의미.
    external_view: Optional[bool] = None
    created_at: datetime
    # Computed by the list service (single grouped query).
    report_count: int = 0


class FolderListResponse(BaseModel):
    items: list[FolderRead]
    uncategorized_count: int = 0


class FolderCreate(BaseModel):
    """Same payload for both personal and org create — the route
    decides the scope from the `workspace_slug` query param."""

    name: str = Field(..., min_length=1, max_length=128)
    parent_id: Optional[int] = None
    sort_order: int = 0


class FolderUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=128)
    # 'parent_id' in payload distinguishes "move to root" (null) vs
    # "leave unchanged" (omitted).
    parent_id: Optional[int] = None
    sort_order: Optional[int] = None
    # 조직 간 공개 3-state. 'external_view' in payload 면 변경 — null=상속,
    # true=공개, false=비공개. 키 자체가 없으면 그대로 둔다(parent_id 와 동일 패턴).
    external_view: Optional[bool] = None
