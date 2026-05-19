"""Pydantic schemas for section taxonomy."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


_SLUG_PATTERN = r"^[a-z0-9][a-z0-9_-]*$"
_COLOR_PATTERN = r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$"


class SectionItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    code: str
    category_slug: str
    label: str
    en: Optional[str]
    sort_order: int
    created_at: datetime
    updated_at: datetime


class SectionCategoryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    slug: str
    name: str
    color: str
    sort_order: int
    items: list[SectionItemRead] = []
    created_at: datetime
    updated_at: datetime


class SectionCategoryCreate(BaseModel):
    slug: str = Field(..., min_length=1, max_length=48, pattern=_SLUG_PATTERN)
    name: str = Field(..., min_length=1, max_length=64)
    color: str = Field(default="#64748b", pattern=_COLOR_PATTERN)
    sort_order: int = 0


class SectionCategoryUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=64)
    color: Optional[str] = Field(default=None, pattern=_COLOR_PATTERN)
    sort_order: Optional[int] = None


class SectionItemCreate(BaseModel):
    code: str = Field(..., min_length=1, max_length=48, pattern=_SLUG_PATTERN)
    category_slug: str = Field(..., min_length=1, max_length=48, pattern=_SLUG_PATTERN)
    label: str = Field(..., min_length=1, max_length=64)
    en: Optional[str] = Field(default=None, max_length=64)
    sort_order: int = 0


class SectionItemUpdate(BaseModel):
    # Code is immutable; if the user wants a different code they must
    # delete and recreate. Category can be moved, label/en/sort freely
    # editable.
    category_slug: Optional[str] = Field(
        default=None, min_length=1, max_length=48, pattern=_SLUG_PATTERN
    )
    label: Optional[str] = Field(default=None, min_length=1, max_length=64)
    en: Optional[str] = Field(default=None, max_length=64)
    sort_order: Optional[int] = None
