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
    # true → 관리자가 임시 비번을 발급한 계정. 프론트는 로그인 직후 강제
    # 비번 변경 화면으로 보낸다.
    must_change_password: bool = False


class PasswordResetRequestCreate(BaseModel):
    """공개 '비밀번호 찾기' 요청. 이메일 존재 여부는 응답에 노출하지 않는다."""

    email: EmailStr


class RegisterRequest(BaseModel):
    email: EmailStr
    name: str = Field(..., min_length=1, max_length=128)
    password: str = Field(..., min_length=8, max_length=128)
    # admin 이 계정 관리에서 신규 계정을 만들 때 함께 지정하는 소속 부서.
    # 비워두면 home 미지정 상태로 만들어지고, 나중에 PUT /users/{id}/home-
    # workspace 로 채울 수 있다.
    workspace_slug: str | None = Field(default=None, max_length=64)


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
