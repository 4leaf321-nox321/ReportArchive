"""Pydantic schemas for workspaces."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.workspaces.models import WorkspaceKind, WorkspaceStatus


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
    # TF 수명(TF조직_설계.md §7). org/personal/virtual 은 항상 active. 프런트가
    # archived TF 를 picker 에서 숨기고 읽기전용 배너를 그릴 때 읽는다.
    status: WorkspaceStatus = WorkspaceStatus.active
    archived_at: Optional[datetime] = None
    # TF 개설자(감독·표시용). org 는 NULL.
    created_by_user_id: Optional[int] = None


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


class TFWorkspaceCreate(BaseModel):
    """TF(태스크포스) 개설 — 보직장 self-service(TF조직_설계.md §4). 슬러그는
    서버가 생성(`tf-…`), parent 는 항상 NULL(트리 밖). 개설자는 자동으로 매니저
    멤버가 되고, member_emails 로 다른 부서 사용자를 바로 차출할 수 있다."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=128)
    description: str = ""
    # 개설 시 함께 추가할 멤버(이메일). 부서 무관 — cross-functional 차출.
    # 존재하지 않는 이메일은 무시(부분 성공)하고 결과에 누락분을 알린다.
    member_emails: list[str] = Field(default_factory=list)


class TFArchiveUpdate(BaseModel):
    """TF 보관/복원 토글(TF조직_설계.md §7). archived=True 면 읽기전용 보존."""

    model_config = ConfigDict(extra="forbid")

    archived: bool


class WorkspaceBulkCreateItem(BaseModel):
    """One row in a bulk-create paste. Parent is resolved by name —
    case-insensitive, trimmed — against existing workspaces or against
    earlier rows in the same batch. Empty/null parent → root."""

    name: str = Field(..., min_length=1, max_length=128)
    parent_name: Optional[str] = None


class WorkspaceBulkCreate(BaseModel):
    items: list[WorkspaceBulkCreateItem] = Field(..., min_length=1)
