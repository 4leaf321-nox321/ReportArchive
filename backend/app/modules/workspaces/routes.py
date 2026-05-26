"""Workspace routes — read-only catalog (any user) + admin CRUD."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.users.models import User
from app.modules.workspaces import services
from app.modules.workspaces.models import Workspace, WorkspaceKind
from app.modules.workspaces.schemas import (
    WorkspaceBulkCreate,
    WorkspaceCreate,
    WorkspaceRead,
    WorkspaceUpdate,
)
from app.shared.auth import (
    CurrentUser,
    get_current_user_no_workspace,
    require_system_admin,
)
from app.shared.responses import (
    created_response,
    not_found_response,
    success_response,
)

router = APIRouter()


@router.get("")
def list_all_workspaces(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_no_workspace),
):
    """Return the workspace registry visible to the caller. Tree shape is
    built on the client. Doesn't require X-Workspace-Slug — this endpoint
    is what the client calls to discover workspaces in the first place.

    Visibility rules:
      * org / virtual workspaces — everyone sees them (catalog data).
      * personal workspaces — only the owner (and system admins) see
        them. Without this filter the payload leaks every user's
        display name (the workspace name is "{user.name} (개인)"),
        which is a privacy issue even though the existing UI consumers
        filter `kind=='personal'` for tree rendering.
    """
    all_rows = services.list_workspaces(db)
    if user.is_system_admin:
        visible = all_rows
    else:
        visible = [
            w
            for w in all_rows
            if w.kind != WorkspaceKind.personal
            or w.personal_owner_user_id == user.id
        ]
    items = [WorkspaceRead.model_validate(w) for w in visible]
    return success_response(data=items)


@router.post("")
def create_workspace(
    payload: WorkspaceCreate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    try:
        ws = services.create_workspace(db, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=WorkspaceRead.model_validate(ws))


@router.post("/bulk")
def bulk_create_workspaces(
    payload: WorkspaceBulkCreate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    """Bulk-create from a paste table. Parent column carries the parent's
    *name*, not its slug — operators copy from a spreadsheet that doesn't
    know slugs. See `services.bulk_create_workspaces` for resolution rules."""
    try:
        created = services.bulk_create_workspaces(db, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(
        data=[WorkspaceRead.model_validate(w) for w in created]
    )


@router.patch("/{slug}")
def update_workspace(
    slug: str,
    payload: WorkspaceUpdate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    ws = db.get(Workspace, slug)
    if not ws:
        return not_found_response(f"부서를 찾을 수 없습니다: {slug}")
    if ws.virtual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "가상 부서는 수정할 수 없습니다."
        )
    try:
        ws = services.update_workspace(db, ws, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(data=WorkspaceRead.model_validate(ws))


@router.delete("/{slug}")
def delete_workspace(
    slug: str,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    ws = db.get(Workspace, slug)
    if not ws:
        return not_found_response(f"부서를 찾을 수 없습니다: {slug}")
    if ws.virtual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "가상 부서는 삭제할 수 없습니다."
        )
    # personal-{user_id} workspaces are auto-provisioned per user and own
    # the user's reports — deleting one would either CASCADE-drop those
    # reports or RESTRICT-block, and either outcome is wrong via this
    # API. The user's own personal space is managed by the user-lifecycle
    # flow (signup creates it; user-delete cascades it away).
    if ws.kind == WorkspaceKind.personal:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "개인 작업공간은 이 경로로 삭제할 수 없습니다. "
            "사용자 계정을 삭제하면 함께 제거됩니다.",
        )
    try:
        services.delete_workspace(db, ws)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return success_response(data=None, message="부서가 삭제되었습니다.")


@router.get("/{slug}/dependents")
def workspace_dependents(
    slug: str,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    """Returns counts of children/members/reports/templates so the admin UI
    can show 'blocked by N items' before attempting delete."""
    ws = db.get(Workspace, slug)
    if not ws:
        return not_found_response(f"부서를 찾을 수 없습니다: {slug}")
    return success_response(data=services.workspace_blockers(db, slug))
