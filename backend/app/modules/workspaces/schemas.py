"""Pydantic schemas for workspaces."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.workspaces.models import WorkspaceKind


class WorkspaceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    slug: str
    name: str
    description: str
    parent_slug: Optional[str]
    # #rrggbb hex — server-computed from the tree, never client-set.
    color: str
    # Legacy aggregate flag — kept for backward-compat reads. New code
    # should branch on `kind` instead (which carries the same signal in a
    # 3-valued form). Frontend tree builder will switch over in Phase 1.
    virtual: bool
    kind: WorkspaceKind
    # Only populated when kind=personal; NULL otherwise. Lets the frontend
    # render "내 공간" badge / scope personal-workspace-only actions.
    personal_owner_user_id: Optional[int] = None
    sort_order: int
    # 조직 간 공개(조직간공개_설계.md §4.1) — 이 게시판 기본 공개정책. org 에만
    # 의미. 프런트가 공개 토글/뱃지를 그릴 때 현재 상태로 읽는다.
    external_view_default: bool = False


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


class WorkspaceExternalViewUpdate(BaseModel):
    """게시판 기본 공개정책 전용 PATCH(조직간공개_설계.md §8 (a)). 시스템관리자
    전용인 일반 WorkspaceUpdate 와 분리해 공개 토글만 게시판 매니저에게 위임한다."""

    model_config = ConfigDict(extra="forbid")

    external_view_default: bool


class WorkspaceBulkCreateItem(BaseModel):
    """One row in a bulk-create paste. Parent is resolved by name —
    case-insensitive, trimmed — against existing workspaces or against
    earlier rows in the same batch. Empty/null parent → root."""

    name: str = Field(..., min_length=1, max_length=128)
    parent_name: Optional[str] = None


class WorkspaceBulkCreate(BaseModel):
    items: list[WorkspaceBulkCreateItem] = Field(..., min_length=1)
