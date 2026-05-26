"""Pydantic schemas for workspace member management."""
from __future__ import annotations

import enum
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, EmailStr

from app.modules.users.models import Role


class MemberSource(str, enum.Enum):
    """Where a member entry comes from relative to the viewed workspace.

    direct      — workspace_members row on this exact workspace
    inherited   — row on an ancestor workspace (cascades down)
    descendant  — row on a child workspace (admin can see + manage it)
    """

    direct = "direct"
    inherited = "inherited"
    descendant = "descendant"


class MemberRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int  # workspace_members row id (for delete/update reference)
    user_id: int
    email: str
    name: str
    role: Role
    source: MemberSource = MemberSource.direct
    # The workspace the membership row actually lives on. Equals the viewed
    # workspace for source=direct; an ancestor or descendant slug otherwise.
    source_workspace_slug: str
    created_at: Optional[datetime] = None
    # 이 row 가 사용자의 '소속 부서' 인지 — 부서 멤버 페이지에서 제거
    # 버튼을 비활성으로 표시하고 '계정 관리 에서 옮긴 뒤 빼라' 라고
    # 안내하기 위한 플래그. 기존 클라이언트는 무시 가능 (default=False).
    is_home: bool = False


class AddMemberRequest(BaseModel):
    """Add an existing user (by email) to the workspace with a role."""

    email: EmailStr
    role: Role


class UpdateMemberRequest(BaseModel):
    """Update an existing membership.

    Either field can be omitted; at least one must be set. When
    `workspace_slug` differs from the row's current workspace, the row is
    reassigned (subject to scope validation in the route). The target
    workspace must be the URL workspace or one of its descendants.
    """

    role: Optional[Role] = None
    workspace_slug: Optional[str] = None


# Kept as an alias for backwards compatibility with older imports.
UpdateRoleRequest = UpdateMemberRequest
