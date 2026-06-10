"""Pydantic schemas for users / me."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.users.models import Role


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    name: str
    # true → 관리자가 임시 비번을 발급. 프론트가 강제 변경 화면으로 보낸다.
    must_change_password: bool = False


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


class UpdatePreferencesRequest(BaseModel):
    """현재 사용자의 환경설정(preferences) 부분 패치. 보낸 키만 깊은 병합
    되므로 한 위젯 type 의 "제목 생략" 기본값 하나만 보내도 나머지는 유지된다.
    예: {"preferences": {"widget_caption_skip_autofill": {"image": true}}}"""

    preferences: dict


class MeRead(BaseModel):
    user: UserRead
    workspace_slug: Optional[str] = None
    role: Optional[Role] = None
    # 사용자별 환경설정 — 본인 응답에만 실린다(UserRead 는 타 사용자 목록에도
    # 쓰여서 거기에 두면 새므로, 여기 MeRead 최상위에 둔다).
    preferences: dict = {}
    # 조직 간 공개(조직간공개_설계.md Phase 5). 현재 워크스페이스의 멤버는
    # 아니지만 공개 컨텐츠가 있어 *읽기전용*으로 진입한 외부 열람자면 True.
    # 프런트가 읽기전용 배너·쓰기 affordance 숨김을 그리는 신호.
    public_view: bool = False
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


class PasswordResetRequestRead(BaseModel):
    """관리자 큐에 보이는 비밀번호 찾기 요청 한 건."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    user_id: Optional[int] = None
    user_name: Optional[str] = None  # 매칭 계정 이름(없으면 미가입 이메일)
    created_at: datetime


class ResolvePasswordResetRequest(BaseModel):
    """관리자가 임시 비번을 발급하며 요청을 해소."""

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


class AccountAdminRead(BaseModel):
    """Wide view of a user account for the system-admin "계정 관리" page.
    UserRead is intentionally slim (id/email/name) because most code paths
    only need a display tuple; the admin page needs status + audit
    columns, so this dedicated shape avoids leaking those fields onto
    every UserRead consumer."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    name: str
    is_active: bool
    is_system_admin: bool
    created_at: datetime
    # 부서(workspace) 소속 개수 — 1보다 작으면 sign 자체는 잘 됐지만
    # 어디에도 멤버로 안 잡혀 있다는 뜻. 화면에서 '소속 없음' 경고용.
    # personal-{id} workspace 도 포함되므로 보통 최소 1.
    membership_count: int = 0
    # 소속 부서. signup 시 선택한 부서 또는 admin 이 계정 관리에서
    # 변경한 값. NULL 가능 — admin 이 만든 계정인데 아직 home 미지정.
    home_workspace_slug: Optional[str] = None
    home_workspace_name: Optional[str] = None


class AccountMembershipRead(BaseModel):
    """계정 관리 detail 다이얼로그에서 한 부서 row 를 그리기 위한 슬림 shape.
    role 은 라벨링용 (매니저/사용자), kind/virtual 은 personal 워크스페이스를
    구분해 따로 표시할지 결정용. workspace_name 이 화면에서 그대로 보임."""

    model_config = ConfigDict(from_attributes=True)

    workspace_slug: str
    workspace_name: str
    workspace_kind: str
    role: Role
    is_home: bool = False


class AccountAdminDetailRead(BaseModel):
    """AccountAdminRead 와 같은 wide view + 부서 멤버십 전체 리스트.
    계정 관리 페이지에서 한 행을 클릭했을 때 다이얼로그가 사용."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    name: str
    is_active: bool
    is_system_admin: bool
    created_at: datetime
    home_workspace_slug: Optional[str] = None
    home_workspace_name: Optional[str] = None
    memberships: list[AccountMembershipRead] = []


class SetUserActiveRequest(BaseModel):
    """Toggle User.is_active. 비활성화하면 로그인이 즉시 막히고, 진행 중
    이던 모든 세션은 다음 요청에서 401. 본인 비활성 + 마지막 시스템
    관리자 비활성은 service 가 거절."""

    is_active: bool


class SetHomeWorkspaceRequest(BaseModel):
    """admin 이 사용자의 home(소속) 부서를 변경. NULL 명시 시 home 해제.
    실제 부서로 변경 시 라우트가 자동으로 WorkspaceMember 행도 확보 —
    home 인데 멤버십 없는 모순 상태가 되지 않게."""

    workspace_slug: Optional[str] = Field(default=None, max_length=64)
