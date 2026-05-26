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
