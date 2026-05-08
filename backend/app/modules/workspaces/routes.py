"""Workspace routes — read-only catalog (any user) + admin CRUD."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.users.models import User
from app.modules.workspaces import services
from app.modules.workspaces.models import Workspace
from app.modules.workspaces.schemas import (
    WorkspaceCreate,
    WorkspaceRead,
    WorkspaceUpdate,
)
from app.shared.auth import (
    CurrentUser,
    get_current_user_no_workspace,
    require_admin,
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
    _: User = Depends(get_current_user_no_workspace),
):
    """Return the full workspace registry. Tree shape is built on the client.
    Doesn't require X-Workspace-Slug — this endpoint is what the client
    calls to discover workspaces in the first place."""
    items = [WorkspaceRead.model_validate(w) for w in services.list_workspaces(db)]
    return success_response(data=items)


@router.post("")
def create_workspace(
    payload: WorkspaceCreate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_admin),
):
    try:
        ws = services.create_workspace(db, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=WorkspaceRead.model_validate(ws))


@router.patch("/{slug}")
def update_workspace(
    slug: str,
    payload: WorkspaceUpdate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_admin),
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
    _: CurrentUser = Depends(require_admin),
):
    ws = db.get(Workspace, slug)
    if not ws:
        return not_found_response(f"부서를 찾을 수 없습니다: {slug}")
    if ws.virtual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "가상 부서는 삭제할 수 없습니다."
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
    _: CurrentUser = Depends(require_admin),
):
    """Returns counts of children/members/reports/templates so the admin UI
    can show 'blocked by N items' before attempting delete."""
    ws = db.get(Workspace, slug)
    if not ws:
        return not_found_response(f"부서를 찾을 수 없습니다: {slug}")
    return success_response(data=services.workspace_blockers(db, slug))
