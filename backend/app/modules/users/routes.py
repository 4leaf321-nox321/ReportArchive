"""User routes — current actor info + admin-facing user listing + profile."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.auth.services import hash_password, verify_password
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.users.schemas import (
    AccountAdminDetailRead,
    AccountAdminRead,
    AccountMembershipRead,
    AdminSetPasswordRequest,
    ChangePasswordRequest,
    MembershipRead,
    MeRead,
    SetHomeWorkspaceRequest,
    SetSystemAdminRequest,
    SetUserActiveRequest,
    SystemAdminUserRead,
    UpdateProfileRequest,
    UserRead,
)
from app.modules.workspaces.models import Workspace
from app.shared.auth import (
    CurrentUser,
    get_current_user_no_workspace,
    require_admin,
    require_system_admin,
)
from app.shared.responses import success_response

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


@router.get("/me")
def get_me(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_no_workspace),
    x_workspace_slug: Optional[str] = Header(default=None, alias="X-Workspace-Slug"),
):
    """Returns the current user, their memberships, and — if a workspace
    header is present and they have access — the role on that workspace.

    Doesn't require a workspace header so the frontend can call /api/me
    immediately after login (before workspaces have loaded)."""
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
        elif ws and ws.virtual and memberships:
            active_role = Role.user

    payload = MeRead(
        user=UserRead.model_validate(user),
        workspace_slug=active_slug,
        role=active_role,
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
    )
    return success_response(data=payload)


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
    db.commit()
    return success_response(data=None, message="비밀번호가 변경되었습니다.")


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


@router.get("/users/system-admins")
def list_system_admins(
    db: Session = Depends(get_db),
    _actor: User = Depends(require_system_admin),
):
    """Returns every user with `is_system_admin=true`. System-admin only —
    publishing the list to non-admins leaks the "who can take over the
    system" surface area."""
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


@router.post("/users/{user_id}/password")
def admin_set_user_password(
    user_id: int,
    payload: AdminSetPasswordRequest,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_admin),
):
    """Admin force-resets another user's password.

    Permission rule: the target must share at least one workspace inside the
    actor's admin tree. This stops a `dev` admin from resetting a `biz`-only
    user's password just because they're admin somewhere.
    """
    target = db.get(User, user_id)
    if not target or not target.is_active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "사용자를 찾을 수 없습니다.")

    from app.modules.workspaces import services as ws_services

    actor_admin_slugs: set[str] = set()
    actor_memberships = db.execute(
        select(WorkspaceMember).where(WorkspaceMember.user_id == actor.user.id)
    ).scalars()
    for m in actor_memberships:
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

    target.password_hash = hash_password(payload.new_password)
    db.commit()
    return success_response(
        data=None, message=f"{target.email}의 비밀번호가 재설정되었습니다."
    )
