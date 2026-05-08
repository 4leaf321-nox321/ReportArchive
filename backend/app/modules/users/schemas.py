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


class MeRead(BaseModel):
    user: UserRead
    workspace_slug: Optional[str] = None
    role: Optional[Role] = None
    memberships: list[MembershipRead]


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
