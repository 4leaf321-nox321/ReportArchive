"""User routes — current actor info + admin-facing user listing + profile."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.access_logs import services as access_log_services
from app.modules.auth.services import hash_password, verify_password
from app.modules.users import pat
from app.modules.users import services as user_services
from app.modules.users.models import (
    PasswordResetRequest,
    PasswordResetStatus,
    Role,
    User,
    WorkspaceMember,
)
from app.modules.users.schemas import (
    AccountAdminDetailRead,
    AccountAdminRead,
    AccountMembershipRead,
    AdminSetPasswordRequest,
    ChangePasswordRequest,
    McpTokenCreate,
    McpTokenRead,
    MembershipRead,
    MeRead,
    PasswordResetRequestRead,
    PasswordResetTokenRead,
    ResolvePasswordResetRequest,
    SetHomeWorkspaceRequest,
    SetSystemAdminRequest,
    SetUserActiveRequest,
    SystemAdminUserRead,
    UpdatePreferencesRequest,
    UpdateProfileRequest,
    UserRead,
)
from datetime import datetime, timedelta
from app.modules.workspaces.models import Workspace
from app.shared.auth import (
    CurrentUser,
    _workspace_has_public_content,
    get_current_user_no_workspace,
    require_admin,
    require_system_admin,
)
from app.shared.responses import not_found_response, success_response

router = APIRouter()


def _account_read(db: Session, user: User, *, membership_count: int) -> AccountAdminRead:
    """단일 사용자에 대한 AccountAdminRead 패킹. home_workspace 이름까지
    같이 조회. set_user_active / set_user_home_workspace 가 모두 같은 응답
    형태를 사용하기에 헬퍼로."""
    home_name = None
    if user.home_workspace_slug:
        ws = db.get(Workspace, user.home_workspace_slug)
        home_name = ws.name if ws else None
    return AccountAdminRead(
        id=user.id,
        email=user.email,
        name=user.name,
        is_active=user.is_active,
        is_system_admin=user.is_system_admin,
        created_at=user.created_at,
        membership_count=membership_count,
        home_workspace_slug=user.home_workspace_slug,
        home_workspace_name=home_name,
    )


def _ai_features_for(db, user) -> set[str]:
    """app.ai.entitlements 를 호출 시점에 import — 모듈 로드 순환(entitlements 가
    users.models 를 참조)을 끊는다."""
    from app.ai.entitlements import ai_features_for

    return ai_features_for(db, user)


@router.get("/me")
def get_me(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_no_workspace),
    x_workspace_slug: Optional[str] = Header(default=None, alias="X-Workspace-Slug"),
):
    """Returns the current user, their memberships, and — if a workspace
    header is present and they have access — the role on that workspace.

    Doesn't require a workspace header so the frontend can call /api/me
    immediately after login (before workspaces have loaded)."""
    # 세션 복원 접속 기록 — '로그인 유지'로 토큰만 들고 재방문하는 사용자도
    # 접속 이력에 잡히게 한다(스로틀로 도배 방지). 단 PAT(rat_…, MCP 등 외부
    # 클라이언트)는 사람의 접속이 아니므로 제외한다.
    auth_parts = request.headers.get("authorization", "").split()
    token = auth_parts[1] if len(auth_parts) == 2 else ""
    if token and not token.startswith(pat.TOKEN_PREFIX):
        access_log_services.touch_session(
            db, user_id=user.id, email=user.email, request=request
        )
    # Bring back the Workspace row alongside the membership so the
    # response carries display name + kind without forcing a second
    # /api/workspaces lookup on the client (and so the profile page can
    # hide self-admin memberships on personal workspaces).
    rows = list(
        db.execute(
            select(WorkspaceMember, Workspace)
            .join(Workspace, Workspace.slug == WorkspaceMember.workspace_slug)
            .where(WorkspaceMember.user_id == user.id)
        )
    )
    memberships = [m for (m, _ws) in rows]
    workspace_by_slug = {ws.slug: ws for (_m, ws) in rows}

    active_slug = x_workspace_slug
    active_role: Optional[Role] = None
    public_view = False

    if active_slug:
        ws = db.get(Workspace, active_slug)
        if ws and not ws.virtual:
            visited: set[str] = set()
            cur: Optional[str] = active_slug
            while cur and cur not in visited:
                visited.add(cur)
                m = next((m for m in memberships if m.workspace_slug == cur), None)
                if m:
                    active_role = m.role
                    break
                node = db.get(Workspace, cur)
                if not node:
                    break
                cur = node.parent_slug
            # 멤버도 시스템관리자도 아닌데 공개 컨텐츠가 있어 읽기전용 진입 —
            # get_current_user 의 public_viewer 진입 조건과 동일(§Phase 5).
            if (
                active_role is None
                and not user.is_system_admin
                and _workspace_has_public_content(db, active_slug)
            ):
                public_view = True
        elif ws and ws.virtual and memberships:
            active_role = Role.user

    payload = MeRead(
        user=UserRead.model_validate(user),
        workspace_slug=active_slug,
        role=active_role,
        public_view=public_view,
        home_workspace_slug=user.home_workspace_slug,
        memberships=[
            MembershipRead(
                workspace_slug=m.workspace_slug,
                role=m.role,
                workspace_name=(
                    ws.name if (ws := workspace_by_slug.get(m.workspace_slug)) else None
                ),
                workspace_kind=(
                    ws.kind.value
                    if (ws := workspace_by_slug.get(m.workspace_slug))
                    else None
                ),
            )
            for m in memberships
        ],
        is_system_admin=user.is_system_admin,
        preferences=user.preferences or {},
        # 지연 import — entitlements ↔ users 순환 회피(앱 부팅 시점 의존 끊기).
        ai_features=sorted(_ai_features_for(db, user)),
    )
    return success_response(data=payload)


def _deep_merge_prefs(base: dict, patch: dict) -> dict:
    """중첩 dict 는 재귀 병합, 그 외 값은 교체. 새 dict 를 만들어 반환해
    JSONB 변경이 SQLAlchemy 에 dirty 로 잡히게 한다."""
    out = dict(base or {})
    for key, val in (patch or {}).items():
        if isinstance(val, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge_prefs(out[key], val)
        else:
            out[key] = val
    return out


@router.patch("/me/preferences")
def update_my_preferences(
    payload: UpdatePreferencesRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_no_workspace),
):
    """현재 사용자 환경설정 부분 패치(깊은 병합). 위젯 "제목 생략" 기본값처럼
    클라이언트가 자유롭게 쓰는 설정을 저장한다. 병합된 preferences 를 반환."""
    user.preferences = _deep_merge_prefs(user.preferences or {}, payload.preferences)
    db.commit()
    db.refresh(user)
    return success_response(data={"preferences": user.preferences or {}})


@router.patch("/me")
def update_my_profile(
    payload: UpdateProfileRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_no_workspace),
):
    """User edits their own profile. Currently only `name` is editable —
    email change is a separate verified flow (not implemented).

    Side effect: keeps the user's personal workspace display name in
    sync. Without this, the personal workspace stays on "{old name}
    (개인)" and shows up as that everywhere else the workspace
    name is rendered (admin tools, dashboards). Format mirrors what
    ensure_personal_workspace produces on creation.
    """
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"]:
        new_name = data["name"]
        user.name = new_name
        personal_slug = f"personal-{user.id}"
        personal_ws = db.get(Workspace, personal_slug)
        if personal_ws is not None:
            # Match ensure_personal_workspace's fallback ladder so a user
            # who clears their name to empty still gets a sensible label.
            local_part = (user.email or "").split("@", 1)[0]
            display_base = (
                new_name.strip() or local_part or f"user{user.id}"
            )
            personal_ws.name = f"{display_base} (개인)"
    db.commit()
    db.refresh(user)
    return success_response(data=UserRead.model_validate(user))


@router.post("/me/password")
def change_my_password(
    payload: ChangePasswordRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_no_workspace),
):
    """Self-service password change. Verifies current password before
    accepting the new one — protects against unattended-browser hijack."""
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "현재 비밀번호가 올바르지 않습니다."
        )
    if payload.current_password == payload.new_password:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "새 비밀번호가 현재 비밀번호와 같습니다."
        )
    user.password_hash = hash_password(payload.new_password)
    # 임시 비번으로 강제 변경된 상태였다면 여기서 해제 — 정상 로그인 재개.
    user.must_change_password = False
    db.commit()
    return success_response(data=None, message="비밀번호가 변경되었습니다.")


# ─── 개인 액세스 토큰 (MCP 등 외부 클라이언트용) ─────────────────────────
@router.get("/me/mcp-tokens")
def list_my_mcp_tokens(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_no_workspace),
):
    """내 토큰 목록(평문 제외). 상태는 revoked_at/expires_at 로 판단."""
    rows = pat.list_tokens(db, user.id)
    return success_response(data=[McpTokenRead.model_validate(r) for r in rows])


@router.post("/me/mcp-tokens")
def create_my_mcp_token(
    payload: McpTokenCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_no_workspace),
):
    """새 토큰 발급. 평문(`token`)은 **이 응답에서 1회만** 노출된다(이후 조회 불가)."""
    row, plaintext = pat.create_token(
        db, user.id, payload.name, expires_days=payload.expires_days
    )
    return success_response(
        data={"token": plaintext, "info": McpTokenRead.model_validate(row)},
        message="토큰이 생성되었습니다. 지금 복사하세요 — 다시 볼 수 없습니다.",
    )


@router.delete("/me/mcp-tokens/{token_id}")
def delete_my_mcp_token(
    token_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_no_workspace),
):
    """토큰 삭제(즉시 무효화 + 목록에서 제거). 남의 토큰이거나 없으면 404."""
    if not pat.delete_token(db, user.id, token_id):
        return not_found_response("토큰을 찾을 수 없습니다.")
    return success_response(data=None, message="토큰을 삭제했습니다.")


@router.get("/users")
def search_users(
    search: str = "",
    limit: int = 20,
    db: Session = Depends(get_db),
    _actor: CurrentUser = Depends(require_admin),
):
    """Admin-only: find users by email or name (for adding members)."""
    query = select(User).where(User.is_active.is_(True))
    if search.strip():
        like = f"%{search.strip().lower()}%"
        from sqlalchemy import func, or_

        query = query.where(
            or_(func.lower(User.email).like(like), func.lower(User.name).like(like))
        )
    query = query.order_by(User.email).limit(min(limit, 100))
    results = list(db.execute(query).scalars())
    return success_response(data=[UserRead.model_validate(u) for u in results])


@router.get("/users/all")
def list_all_accounts(
    include_inactive: bool = True,
    db: Session = Depends(get_db),
    _actor: User = Depends(require_system_admin),
):
    """System-admin only: 모든 가입자 계정의 wide view. 부서 멤버 관리와는
    분리된 '계정 관리' 페이지가 사용한다. include_inactive=False 면 활성
    계정만 — 비활성화된 사용자는 로그인 차단 상태라 일상 admin 작업에선
    숨겨 두는 게 보기 편한 선택."""
    from sqlalchemy import func

    stmt = select(User)
    if not include_inactive:
        stmt = stmt.where(User.is_active.is_(True))
    stmt = stmt.order_by(User.created_at.desc())
    users = list(db.execute(stmt).scalars())

    # workspace_members count per user — 단일 쿼리로 묶어서 N+1 회피.
    counts = dict(
        db.execute(
            select(
                WorkspaceMember.user_id,
                func.count(WorkspaceMember.id),
            ).group_by(WorkspaceMember.user_id)
        ).all()
    )

    # home_workspace 이름 — 화면에서 slug 가 아니라 사람이 읽는 이름으로
    # 노출하기 위해 한 번에 가져옴. 일부 사용자는 home 미지정(NULL).
    home_slugs = {u.home_workspace_slug for u in users if u.home_workspace_slug}
    home_names: dict[str, str] = {}
    if home_slugs:
        rows = db.execute(
            select(Workspace.slug, Workspace.name).where(
                Workspace.slug.in_(home_slugs)
            )
        ).all()
        home_names = {slug: name for (slug, name) in rows}

    return success_response(
        data=[
            AccountAdminRead(
                id=u.id,
                email=u.email,
                name=u.name,
                is_active=u.is_active,
                is_system_admin=u.is_system_admin,
                created_at=u.created_at,
                membership_count=int(counts.get(u.id, 0)),
                home_workspace_slug=u.home_workspace_slug,
                home_workspace_name=home_names.get(u.home_workspace_slug),
            )
            for u in users
        ]
    )


@router.get("/users/system-admins")
def list_system_admins(
    db: Session = Depends(get_db),
    _actor: User = Depends(require_system_admin),
):
    """Returns every user with `is_system_admin=true`. System-admin only —
    publishing the list to non-admins leaks the "who can take over the
    system" surface area.

    NOTE: must be declared *before* the `/users/{user_id}` route — otherwise
    FastAPI matches "system-admins" as `user_id` and fails int parsing (422).
    """
    rows = list(
        db.execute(
            select(User)
            .where(User.is_active.is_(True), User.is_system_admin.is_(True))
            .order_by(User.id)
        ).scalars()
    )
    return success_response(
        data=[SystemAdminUserRead.model_validate(u) for u in rows]
    )


@router.get("/users/{user_id}")
def get_account_detail(
    user_id: int,
    db: Session = Depends(get_db),
    _actor: User = Depends(require_system_admin),
):
    """System-admin: 한 계정의 wide view + 부서 멤버십 전체 목록. 계정 관리
    페이지에서 한 행 클릭하면 여는 다이얼로그가 사용. 카운트 숫자만으로는
    부족한 '어느 부서들에 어떤 role 로 속해 있나' 를 한눈에 보여주려면
    개별 row 조회가 필요해서 별도 endpoint 로."""
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "사용자를 찾을 수 없습니다."
        )
    rows = list(
        db.execute(
            select(WorkspaceMember, Workspace)
            .join(Workspace, Workspace.slug == WorkspaceMember.workspace_slug)
            .where(WorkspaceMember.user_id == user_id)
            .order_by(Workspace.kind, Workspace.name)
        )
    )
    memberships = [
        AccountMembershipRead(
            workspace_slug=ws.slug,
            workspace_name=ws.name,
            workspace_kind=ws.kind.value,
            role=m.role,
            is_home=(target.home_workspace_slug == ws.slug),
        )
        for (m, ws) in rows
    ]
    home_name = None
    if target.home_workspace_slug:
        home_ws = db.get(Workspace, target.home_workspace_slug)
        home_name = home_ws.name if home_ws else None
    return success_response(
        data=AccountAdminDetailRead(
            id=target.id,
            email=target.email,
            name=target.name,
            is_active=target.is_active,
            is_system_admin=target.is_system_admin,
            created_at=target.created_at,
            home_workspace_slug=target.home_workspace_slug,
            home_workspace_name=home_name,
            memberships=memberships,
        )
    )


@router.put("/users/{user_id}/home-workspace")
def set_user_home_workspace(
    user_id: int,
    payload: SetHomeWorkspaceRequest,
    db: Session = Depends(get_db),
    _actor: User = Depends(require_system_admin),
):
    """System-admin: 사용자의 home(소속) 부서를 변경. 새 home 으로 지정된
    부서에는 WorkspaceMember 행도 자동으로 확보(없으면 role=user 로 추가)
    — home != 멤버십 모순 방지. NULL 을 주면 home 만 해제하고 기존 멤버십
    은 건드리지 않는다(다른 부서 멤버십은 여전히 살아있을 수 있음).
    """
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "사용자를 찾을 수 없습니다."
        )

    new_slug = (payload.workspace_slug or "").strip() or None
    if new_slug:
        ws = db.get(Workspace, new_slug)
        if ws is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, f"부서를 찾을 수 없습니다: {new_slug}"
            )
        if ws.virtual:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "가상 부서는 소속으로 지정할 수 없습니다.",
            )
        # 멤버십 확보 — 이미 존재하면 그대로 두고, 없으면 user role 로 추가.
        existing = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.user_id == target.id,
                WorkspaceMember.workspace_slug == new_slug,
            )
        ).scalar_one_or_none()
        if existing is None:
            db.add(
                WorkspaceMember(
                    user_id=target.id,
                    workspace_slug=new_slug,
                    role=Role.user,
                )
            )

    target.home_workspace_slug = new_slug
    db.commit()
    db.refresh(target)

    home_name = None
    if new_slug:
        ws = db.get(Workspace, new_slug)
        home_name = ws.name if ws else None

    return success_response(
        data=AccountAdminRead(
            id=target.id,
            email=target.email,
            name=target.name,
            is_active=target.is_active,
            is_system_admin=target.is_system_admin,
            created_at=target.created_at,
            membership_count=0,  # 화면이 reload 함
            home_workspace_slug=target.home_workspace_slug,
            home_workspace_name=home_name,
        )
    )


@router.put("/users/{user_id}/active")
def set_user_active(
    user_id: int,
    payload: SetUserActiveRequest,
    db: Session = Depends(get_db),
    actor: User = Depends(require_system_admin),
):
    """System-admin: 계정 활성/비활성 토글. 비활성화하면 로그인이 즉시 막힘
    (auth.routes 의 login 이 is_active 를 확인). 두 가지 안전장치:

      1. 본인 자신의 활성 플래그는 끌 수 없다 — 즉시 lockout 가능성.
      2. 비활성화하려는 대상이 현재 살아 있는 마지막 시스템 관리자라면
         거절. 시스템 관리자 self-demote 규칙과 같은 이유 (관리 권한 공백
         방지).
    """
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "사용자를 찾을 수 없습니다."
        )

    new_active = bool(payload.is_active)
    if new_active == target.is_active:
        # 멱등 — 이미 원하는 상태면 그대로 반환.
        return success_response(data=_account_read(db, target, membership_count=0))

    if not new_active:
        if target.id == actor.id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "본인 계정은 비활성화할 수 없습니다.",
            )
        if target.is_system_admin:
            remaining = db.execute(
                select(User.id).where(
                    User.is_active.is_(True),
                    User.is_system_admin.is_(True),
                    User.id != target.id,
                ).limit(1)
            ).first()
            if remaining is None:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "마지막 시스템 관리자 계정은 비활성화할 수 없습니다. "
                    "다른 시스템 관리자를 먼저 임명하거나 본 계정의 시스템 "
                    "관리자 권한을 해제하세요.",
                )

    target.is_active = new_active
    db.commit()
    return success_response(data=_account_read(db, target, membership_count=0))


@router.get("/users/{user_id}/dependents")
def user_delete_dependents(
    user_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_system_admin),
):
    """계정 삭제를 막는 참조 건수 {key: count} — 삭제 다이얼로그가 미리 표시.
    전부 0 이면 하드삭제 가능(조직개편·계정삭제_설계.md §6)."""
    target = db.get(User, user_id)
    if target is None:
        return not_found_response("사용자를 찾을 수 없습니다.")
    return success_response(data=user_services.user_delete_blockers(db, target))


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    actor: User = Depends(require_system_admin),
):
    """System-admin: 계정 완전 삭제(비활성화와 달리 행을 실제로 지운다). 잘못된
    메일주소로 가입한 저흔적 계정 정리용 — 삭제 후 그 이메일이 해방돼 재가입 가능.

    가드는 set_user_active 와 동일:
      1. 본인 계정은 삭제 불가.
      2. 마지막 살아있는 시스템 관리자는 삭제 불가.
    작성한 댓글이나 개인공간 보고서가 있으면 409 로 거부(비활성화 권장)."""
    target = db.get(User, user_id)
    if target is None:
        return not_found_response("사용자를 찾을 수 없습니다.")
    if target.id == actor.id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "본인 계정은 삭제할 수 없습니다."
        )
    if target.is_system_admin:
        remaining = db.execute(
            select(User.id).where(
                User.is_active.is_(True),
                User.is_system_admin.is_(True),
                User.id != target.id,
            ).limit(1)
        ).first()
        if remaining is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "마지막 시스템 관리자 계정은 삭제할 수 없습니다. 다른 시스템 "
                "관리자를 먼저 임명하거나 본 계정의 시스템 관리자 권한을 해제하세요.",
            )
    email = target.email
    try:
        result = user_services.hard_delete_user(db, target)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return success_response(
        data=result, message=f"계정({email})이 완전히 삭제되었습니다."
    )


@router.put("/users/{user_id}/system-admin")
def set_system_admin(
    user_id: int,
    payload: SetSystemAdminRequest,
    db: Session = Depends(get_db),
    actor: User = Depends(require_system_admin),
):
    """Promote / demote a user as system admin. Two safety rails:

      1. Self-demote of the *last* remaining system admin is blocked —
         otherwise the org would be left with no one able to manage
         workspaces, masters, or grant the flag back.
      2. Target must exist + be active. Deactivated users can't be
         promoted (they couldn't log in to use the flag anyway).
    """
    target = db.get(User, user_id)
    if target is None or not target.is_active:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "사용자를 찾을 수 없습니다."
        )

    # Self-demote lockout check — only matters when demoting.
    if (
        not payload.is_system_admin
        and target.id == actor.id
    ):
        # Count remaining admins (excluding the actor) — if zero, refuse.
        remaining = db.execute(
            select(User.id).where(
                User.is_active.is_(True),
                User.is_system_admin.is_(True),
                User.id != actor.id,
            ).limit(1)
        ).first()
        if remaining is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "마지막 시스템 관리자는 본인의 권한을 해제할 수 없습니다. "
                "다른 시스템 관리자를 먼저 임명하세요.",
            )

    target.is_system_admin = payload.is_system_admin
    db.commit()
    return success_response(data=SystemAdminUserRead.model_validate(target))


def _assert_can_reset_password(db: Session, actor: User, target: User) -> None:
    """비번 재설정 권한 검사.

    시스템 관리자는 누구나 가능. 그 외엔 대상이 actor 의 관리 트리(매니저로
    있는 부서 + 그 하위) 안의 부서에 속해 있어야 한다. 한 부서 관리자가
    무관한 부서 유저의 비번을 건드리지 못하게 막는다.
    """
    if actor.is_system_admin:
        return

    from app.modules.workspaces import services as ws_services

    actor_admin_slugs: set[str] = set()
    for m in db.execute(
        select(WorkspaceMember).where(WorkspaceMember.user_id == actor.id)
    ).scalars():
        if m.role == Role.manager:
            actor_admin_slugs.update(
                ws_services.get_descendants_inclusive(db, m.workspace_slug)
            )
    target_slugs = {
        m.workspace_slug
        for m in db.execute(
            select(WorkspaceMember).where(WorkspaceMember.user_id == target.id)
        ).scalars()
    }
    if not (actor_admin_slugs & target_slugs):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 사용자는 본인의 관리 부서에 속해있지 않아 비밀번호를 재설정할 수 없습니다.",
        )


@router.post("/users/{user_id}/password")
def admin_set_user_password(
    user_id: int,
    payload: AdminSetPasswordRequest,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_admin),
):
    """Admin force-resets another user's password.

    Permission rule: the target must share at least one workspace inside the
    actor's admin tree (system admins bypass). This stops a `dev` admin from
    resetting a `biz`-only user's password just because they're admin somewhere.
    """
    target = db.get(User, user_id)
    if not target or not target.is_active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "사용자를 찾을 수 없습니다.")

    _assert_can_reset_password(db, actor.user, target)

    target.password_hash = hash_password(payload.new_password)
    # 발급한 비번은 임시 — 최초 로그인 시 변경 강제.
    target.must_change_password = True
    db.commit()
    return success_response(
        data=None, message=f"{target.email}의 비밀번호가 재설정되었습니다."
    )


def _visible_reset_user_ids(db: Session, actor: User) -> set[int]:
    """actor 의 관리 트리(매니저 부서 + 하위)에 속한 유저 id 집합.

    시스템 관리자는 이 함수를 호출할 필요가 없다(전부 보임) — 호출부가
    is_system_admin 을 먼저 확인한다.
    """
    from app.modules.workspaces import services as ws_services

    admin_slugs: set[str] = set()
    for m in db.execute(
        select(WorkspaceMember).where(WorkspaceMember.user_id == actor.id)
    ).scalars():
        if m.role == Role.manager:
            admin_slugs.update(
                ws_services.get_descendants_inclusive(db, m.workspace_slug)
            )
    if not admin_slugs:
        return set()
    return set(
        db.execute(
            select(WorkspaceMember.user_id).where(
                WorkspaceMember.workspace_slug.in_(admin_slugs)
            )
        ).scalars()
    )


@router.get("/password-reset-requests")
def list_password_reset_requests(
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_admin),
):
    """관리자에게 보이는 '비밀번호 찾기' 대기 목록.

    시스템 관리자는 전부, 부서 관리자는 본인 관리 트리 내 계정의 요청만 본다.
    미가입 이메일(매칭 계정 없음) 요청은 시스템 관리자에게만 노출한다.
    """
    rows = list(
        db.execute(
            select(PasswordResetRequest)
            .where(PasswordResetRequest.status == PasswordResetStatus.pending)
            .order_by(PasswordResetRequest.created_at.asc())
        ).scalars()
    )

    is_sysadmin = actor.user.is_system_admin
    visible_user_ids: set[int] = (
        set() if is_sysadmin else _visible_reset_user_ids(db, actor.user)
    )

    out = []
    for r in rows:
        if r.user_id is None:
            if not is_sysadmin:
                continue  # 미가입 이메일은 시스템 관리자만.
        elif not is_sysadmin and r.user_id not in visible_user_ids:
            continue
        out.append(
            PasswordResetRequestRead(
                id=r.id,
                email=r.email,
                user_id=r.user_id,
                user_name=r.user.name if r.user else None,
                created_at=r.created_at,
            )
        )
    return success_response(data=out)


@router.get("/password-reset-tokens")
def list_password_reset_tokens(
    days: int = 90,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_admin),
):
    """셀프 재설정 토큰 발급 이력(계정 단위 집계).

    용도는 두 가지다. 하나는 셀프 재설정이 켜져 있을 때 누가 재설정을 시도했고
    실제로 완료했는지 보는 것. 다른 하나는 사후 추적 — 메일이 도달하지 않는
    환경에서 셀프 재설정 경로로 요청이 빠져나가면, 관리자 큐에는 안 뜨고 이
    토큰 행만 흔적으로 남는다. 그런 요청을 여기서 찾아 임시 비번을 발급한다.

    가시성은 대기 목록과 같은 규칙(시스템 관리자 전부 / 부서 관리자는 관리
    트리 내 계정). 토큰 해시는 내보내지 않는다.

    한계: 어느 계정과도 매칭되지 않은 이메일로 온 요청은 토큰 자체가 생기지
    않으므로 여기에도 안 나온다.
    """
    from sqlalchemy import func

    from app.modules.users.models import PasswordResetToken

    days = max(1, min(days, 365))
    since = datetime.utcnow() - timedelta(days=days)

    rows = list(
        db.execute(
            select(
                PasswordResetToken.user_id,
                func.count().label("request_count"),
                func.min(PasswordResetToken.created_at).label("first_at"),
                func.max(PasswordResetToken.created_at).label("last_at"),
                func.count(PasswordResetToken.used_at).label("used_count"),
            )
            .where(PasswordResetToken.created_at >= since)
            .group_by(PasswordResetToken.user_id)
            .order_by(func.max(PasswordResetToken.created_at).desc())
        )
    )
    if not rows:
        return success_response(data=[])

    is_sysadmin = actor.user.is_system_admin
    visible_user_ids: set[int] = (
        set() if is_sysadmin else _visible_reset_user_ids(db, actor.user)
    )

    # 이미 관리자 큐에 올라와 있는 계정은 화면에서 중복 처리하지 않도록 표시.
    queued_user_ids = set(
        db.execute(
            select(PasswordResetRequest.user_id).where(
                PasswordResetRequest.status == PasswordResetStatus.pending,
                PasswordResetRequest.user_id.is_not(None),
            )
        ).scalars()
    )

    out = []
    for r in rows:
        if not is_sysadmin and r.user_id not in visible_user_ids:
            continue
        u = db.get(User, r.user_id)
        if u is None:
            continue  # 계정이 지워졌으면 토큰도 CASCADE 로 사라지지만 방어적으로.
        out.append(
            PasswordResetTokenRead(
                user_id=r.user_id,
                email=u.email,
                user_name=u.name,
                user_is_active=u.is_active,
                request_count=r.request_count,
                first_requested_at=r.first_at,
                last_requested_at=r.last_at,
                used_count=r.used_count,
                has_pending_queue_row=r.user_id in queued_user_ids,
            )
        )
    return success_response(data=out)


@router.post("/password-reset-requests/{request_id}/resolve")
def resolve_password_reset_request(
    request_id: int,
    payload: ResolvePasswordResetRequest,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_admin),
):
    """관리자가 본인 확인 후 임시 비번을 발급하며 요청을 해소한다.

    설정한 비번은 임시 — 대상은 최초 로그인 시 변경을 강제받는다.
    """
    req = db.get(PasswordResetRequest, request_id)
    if not req or req.status != PasswordResetStatus.pending:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "처리할 요청을 찾을 수 없습니다."
        )
    if req.user_id is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "가입된 계정이 없는 이메일입니다. 먼저 계정을 생성하세요.",
        )
    target = db.get(User, req.user_id)
    if not target or not target.is_active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "사용자를 찾을 수 없습니다.")

    _assert_can_reset_password(db, actor.user, target)

    target.password_hash = hash_password(payload.new_password)
    target.must_change_password = True
    req.status = PasswordResetStatus.resolved
    req.resolved_by_user_id = actor.user.id
    req.resolved_at = datetime.utcnow()
    db.commit()
    return success_response(
        data=None,
        message=f"{target.email}의 임시 비밀번호가 발급되었습니다. "
        "사용자에게 전달하면 최초 로그인 시 새 비밀번호로 변경됩니다.",
    )


@router.post("/password-reset-requests/{request_id}/dismiss")
def dismiss_password_reset_request(
    request_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_admin),
):
    """처리 불가/무효한 분실 요청을 반려(취소)해 큐에서 정리한다.

    임시 비번 발급 없이 status 만 canceled 로 바꾼다. 오타·미가입 등으로
    매칭 계정이 없는(user_id NULL) 요청은 발급 자체가 불가능하므로 이 경로로만
    정리한다. 권한은 발급과 동일 스코프 — 미가입 이메일이나 계정이 사라진
    요청은 스코프 검증이 불가하므로 시스템 관리자만 반려할 수 있다.
    """
    req = db.get(PasswordResetRequest, request_id)
    if not req or req.status != PasswordResetStatus.pending:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "처리할 요청을 찾을 수 없습니다."
        )
    if req.user_id is None:
        # 미가입 이메일 — 시스템 관리자만(목록 노출 정책과 일치).
        if not actor.user.is_system_admin:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "미가입 이메일 요청은 시스템 관리자만 반려할 수 있습니다.",
            )
    else:
        target = db.get(User, req.user_id)
        if target is None:
            # 계정이 사라진 요청 — 관리 스코프를 확인할 수 없어 시스템 관리자만.
            if not actor.user.is_system_admin:
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN,
                    "이 요청은 시스템 관리자만 반려할 수 있습니다.",
                )
        else:
            _assert_can_reset_password(db, actor.user, target)

    req.status = PasswordResetStatus.canceled
    req.resolved_by_user_id = actor.user.id
    req.resolved_at = datetime.utcnow()
    db.commit()
    return success_response(data=None, message="요청을 반려했습니다.")
