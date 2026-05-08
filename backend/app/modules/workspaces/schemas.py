"""Pydantic schemas for workspaces."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


_HEX_COLOR_PATTERN = r"^#[0-9a-fA-F]{6}$"


class WorkspaceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    slug: str
    name: str
    description: str
    parent_slug: Optional[str]
    color: str  # #rrggbb hex
    virtual: bool
    sort_order: int


class WorkspaceCreate(BaseModel):
    """Slug is immutable post-creation. Color is a hex string (#rrggbb)."""

    slug: str = Field(..., min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9-]*$")
    name: str = Field(..., min_length=1, max_length=128)
    parent_slug: Optional[str] = None
    description: str = ""
    color: str = Field(default="#64748b", pattern=_HEX_COLOR_PATTERN)
    sort_order: int = 0


class WorkspaceUpdate(BaseModel):
    """Slug stays frozen (it's a stable identifier referenced by reports,
    templates, and memberships). Everything else can change — including
    parent_slug to move the workspace within the org tree."""

    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=128)
    description: Optional[str] = None
    color: Optional[str] = Field(default=None, pattern=_HEX_COLOR_PATTERN)
    sort_order: Optional[int] = None
    # When the client sends "parent_slug": null, the value moves to root.
    # When the client omits the field, we leave parent untouched. Pydantic v2
    # exposes `model_fields_set` so the route layer can tell these apart.
    parent_slug: Optional[str] = None
