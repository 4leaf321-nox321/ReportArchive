"""Workspace member management — admin only.

PATCH/DELETE use the workspace_members row id (not user_id) so that admins
viewing a parent workspace can manage members assigned to descendant
workspaces. Permission check: the target row's workspace must be the
URL workspace or one of its descendants — never an ancestor (no privilege
escalation upward).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.members import services
from app.modules.members.schemas import (
    AddMemberRequest,
    MemberRead,
    MemberSource,
    UpdateMemberRequest,
)
from app.modules.users.models import User, WorkspaceMember
from app.modules.workspaces import services as ws_services
from app.modules.workspaces.models import Workspace
from app.shared.auth import CurrentUser, require_admin
from app.shared.responses import (
    created_response,
    not_found_response,
    success_response,
)

router = APIRouter()


def _resolve_target_workspace(db: Session, slug: str) -> Workspace:
    ws = db.get(Workspace, slug)
    if not ws:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"부서를 찾을 수 없습니다: {slug}")
    if ws.virtual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "가상 부서(예: _global)에는 멤버를 직접 추가할 수 없습니다.",
        )
    return ws


def _resolve_member_in_scope(
    db: Session, workspace_slug: str, member_id: int
) -> WorkspaceMember:
    """Loads the membership row and verifies it lives inside the URL
    workspace's tree (self + descendants). Raises 404 / 403 otherwise."""
    member = db.get(WorkspaceMember, member_id)
    if not member:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "멤버십을 찾을 수 없습니다.")
    accessible = set(ws_services.get_descendants_inclusive(db, workspace_slug))
    if member.workspace_slug not in accessible:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "상위 부서의 멤버십은 이 부서 페이지에서 수정할 수 없습니다.",
        )
    return member


def _to_read(db: Session, member: WorkspaceMember, viewing_workspace: str) -> MemberRead:
    user = db.get(User, member.user_id)
    if member.workspace_slug == viewing_workspace:
        source = MemberSource.direct
    else:
        source = MemberSource.descendant  # ancestors aren't reachable through this path
    return MemberRead(
        id=member.id,
        user_id=user.id,
        email=user.email,
        name=user.name,
        role=member.role,
        source=source,
        source_workspace_slug=member.workspace_slug,
        created_at=member.created_at,
    )


@router.get("/{workspace_slug}/members")
def list_members(
    workspace_slug: str,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_admin),
):
    _resolve_target_workspace(db, workspace_slug)
    items = services.list_effective_members(db, workspace_slug)
    return success_response(data=items)


@router.post("/{workspace_slug}/members")
def add_member(
    workspace_slug: str,
    payload: AddMemberRequest,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_admin),
):
    """Add an existing user to this workspace. To add to a descendant, switch
    to that workspace first (admin permission cascades, so this is allowed)."""
    _resolve_target_workspace(db, workspace_slug)
    user = db.execute(
        select(User).where(User.email == payload.email)
    ).scalar_one_or_none()
    if not user:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"등록된 사용자가 아닙니다: {payload.email}. 먼저 계정을 생성하세요.",
        )
    member = services.add_member(db, workspace_slug, user, payload.role)
    return created_response(data=_to_read(db, member, workspace_slug))


@router.patch("/{workspace_slug}/members/{member_id}")
def update_member(
    workspace_slug: str,
    member_id: int,
    payload: UpdateMemberRequest,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_admin),
):
    """Change a membership's role and/or its workspace assignment.

    Reassigning to a different workspace is only allowed when the target
    is the URL workspace itself or one of its descendants — never an
    ancestor or unrelated tree (no upward / lateral privilege escalation).
    """
    if payload.role is None and payload.workspace_slug is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "변경할 항목이 없습니다 (role 또는 workspace_slug)."
        )

    _resolve_target_workspace(db, workspace_slug)
    member = _resolve_member_in_scope(db, workspace_slug, member_id)
    accessible = set(ws_services.get_descendants_inclusive(db, workspace_slug))

    if payload.workspace_slug is not None and payload.workspace_slug != member.workspace_slug:
        if payload.workspace_slug not in accessible:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "이 부서 또는 하위 부서로만 이동할 수 있습니다.",
            )
        target_ws = db.get(Workspace, payload.workspace_slug)
        if not target_ws:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                f"부서를 찾을 수 없습니다: {payload.workspace_slug}",
            )
        if target_ws.virtual:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "가상 부서로는 멤버를 이동할 수 없습니다.",
            )
        if member.user_id == actor.user.id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "본인의 소속 부서는 직접 변경할 수 없습니다 (다른 관리자에게 요청하세요).",
            )
        try:
            services.move_member(db, member, payload.workspace_slug)
        except ValueError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

    if payload.role is not None and member.role != payload.role:
        services.update_role(db, member, payload.role)

    return success_response(data=_to_read(db, member, workspace_slug))


@router.delete("/{workspace_slug}/members/{member_id}")
def remove_member(
    workspace_slug: str,
    member_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_admin),
):
    _resolve_target_workspace(db, workspace_slug)
    member = _resolve_member_in_scope(db, workspace_slug, member_id)
    if member.user_id == actor.user.id and member.workspace_slug == workspace_slug:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "본인을 부서에서 제거할 수 없습니다 (다른 관리자에게 요청하세요).",
        )
    services.remove_member(db, member)
    return success_response(data=None, message="삭제되었습니다.")
