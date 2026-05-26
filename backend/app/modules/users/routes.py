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
    AdminSetPasswordRequest,
    ChangePasswordRequest,
    MembershipRead,
    MeRead,
    SetSystemAdminRequest,
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
    memberships = list(
        db.execute(
            select(WorkspaceMember).where(WorkspaceMember.user_id == user.id)
        ).scalars()
    )

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
            MembershipRead(workspace_slug=m.workspace_slug, role=m.role)
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
    email change is a separate verified flow (not implemented)."""
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"]:
        user.name = data["name"]
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
        if m.role == Role.admin:
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
