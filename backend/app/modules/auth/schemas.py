"""Pydantic schemas for auth endpoints."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class LoginRequest(BaseModel):
    # Plain str (not EmailStr) so short admin-style logins work — the DB
    # column is just text and self-signed-up users still happen to use
    # real emails because RegisterRequest enforces EmailStr separately.
    email: str = Field(..., min_length=1, max_length=255)
    password: str = Field(..., min_length=1)


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "Bearer"
    expires_in: int  # seconds
    user_id: int
    email: str
    name: str


class RegisterRequest(BaseModel):
    email: EmailStr
    name: str = Field(..., min_length=1, max_length=128)
    password: str = Field(..., min_length=8, max_length=128)


class RegisteredUser(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    name: str


class SignupRequest(BaseModel):
    """Public self-signup. The user picks an existing workspace as their
    소속; they get the `user` role on that workspace by default. An admin
    can promote them later."""

    email: EmailStr
    name: str = Field(..., min_length=1, max_length=128)
    password: str = Field(..., min_length=8, max_length=128)
    workspace_slug: str = Field(..., min_length=1, max_length=64)


class PublicWorkspace(BaseModel):
    """Minimal workspace info exposed pre-login for the signup dropdown.
    Doesn't leak descriptions or membership counts — just slug + name."""

    slug: str
    name: str
    parent_slug: str | None = None
