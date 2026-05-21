"""Pydantic schemas for workspaces."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class WorkspaceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    slug: str
    name: str
    description: str
    parent_slug: Optional[str]
    # #rrggbb hex — server-computed from the tree, never client-set.
    color: str
    virtual: bool
    sort_order: int


class WorkspaceCreate(BaseModel):
    """Slug is immutable post-creation. Color is auto-derived from the tree
    (see `compute_workspace_colors`) so clients don't pick it."""

    slug: str = Field(..., min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9-]*$")
    name: str = Field(..., min_length=1, max_length=128)
    parent_slug: Optional[str] = None
    description: str = ""
    sort_order: int = 0


class WorkspaceUpdate(BaseModel):
    """Slug stays frozen (it's a stable identifier referenced by reports,
    templates, and memberships). Everything else except color can change —
    including parent_slug to move the workspace within the org tree. Color
    is server-computed and re-derived whenever parent changes."""

    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=128)
    description: Optional[str] = None
    sort_order: Optional[int] = None
    # When the client sends "parent_slug": null, the value moves to root.
    # When the client omits the field, we leave parent untouched. Pydantic v2
    # exposes `model_fields_set` so the route layer can tell these apart.
    parent_slug: Optional[str] = None


class WorkspaceBulkCreateItem(BaseModel):
    """One row in a bulk-create paste. Parent is resolved by name —
    case-insensitive, trimmed — against existing workspaces or against
    earlier rows in the same batch. Empty/null parent → root."""

    name: str = Field(..., min_length=1, max_length=128)
    parent_name: Optional[str] = None


class WorkspaceBulkCreate(BaseModel):
    items: list[WorkspaceBulkCreateItem] = Field(..., min_length=1)
