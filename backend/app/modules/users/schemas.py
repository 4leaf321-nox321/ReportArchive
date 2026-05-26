"""Pydantic schemas for users / me."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.users.models import Role


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    name: str


class MembershipRead(BaseModel):
    workspace_slug: str
    role: Role
    # Display-side fields populated by /api/users/me from the Workspace
    # row. Optional for backward compat — older clients reading the
    # response can ignore them. workspace_kind lets the profile UI hide
    # personal-workspace memberships from the "소속 부서" section, since
    # the self-admin row on `personal-{user_id}` isn't a department.
    workspace_name: Optional[str] = None
    workspace_kind: Optional[str] = None


class MeRead(BaseModel):
    user: UserRead
    workspace_slug: Optional[str] = None
    role: Optional[Role] = None
    memberships: list[MembershipRead]
    # 시스템 관리자 flag — pulled straight from User.is_system_admin.
    # Distinct from workspace `role`: a 부서 관리자 (role=admin in a
    # workspace) doesn't have this unless explicitly granted.
    is_system_admin: bool = False


class UpdateProfileRequest(BaseModel):
    """User edits own profile. Email is intentionally not editable here —
    changing the login identity is a separate (verified) flow."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=128)


class ChangePasswordRequest(BaseModel):
    """User changes own password. Requires current password to prevent
    session-hijacking from an unattended browser."""

    current_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=8, max_length=128)


class AdminSetPasswordRequest(BaseModel):
    """Admin force-sets another user's password (e.g. account recovery).
    No current_password — admin authority replaces it."""

    new_password: str = Field(..., min_length=8, max_length=128)


class SystemAdminUserRead(BaseModel):
    """One system admin row — what /api/users/system-admins returns."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    name: str
    is_system_admin: bool


class SetSystemAdminRequest(BaseModel):
    """Promote / demote a user as system admin. Self-demote of the last
    remaining system admin is rejected at the service layer (lock-out
    prevention)."""

    is_system_admin: bool
