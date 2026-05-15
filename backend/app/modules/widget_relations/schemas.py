"""Pydantic schemas for widget_relations."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class RelationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    slug: str
    name: str
    description: str | None
    hint_keywords: list[str]
    sort_order: int
    is_builtin: bool
    created_at: datetime
    updated_at: datetime


class RelationCreate(BaseModel):
    slug: str = Field(..., min_length=1, max_length=32, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    name: str = Field(..., min_length=1, max_length=64)
    description: str | None = Field(default=None, max_length=256)
    hint_keywords: list[str] = Field(default_factory=list)
    sort_order: int = 0


class RelationUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    description: str | None = Field(default=None, max_length=256)
    hint_keywords: list[str] | None = None
    sort_order: int | None = None
