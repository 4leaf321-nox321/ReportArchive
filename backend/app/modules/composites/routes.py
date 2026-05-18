"""Composite report routes."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.composites import services
from app.modules.composites.schemas import (
    CompositeReportCreate,
    CompositeReportRead,
    CompositeReportSummary,
    CompositeReportUpdate,
)
from app.modules.workspaces import services as ws_services
from app.shared.auth import CurrentUser, get_current_user, require_writer
from app.shared.responses import (
    created_response,
    not_found_response,
    success_response,
)

router = APIRouter()


@router.get("")
def list_composites(
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    items = services.list_in_workspace_tree(
        db, actor.workspace.slug, is_global_view=actor.workspace.virtual
    )
    payload = [CompositeReportSummary.model_validate(c) for c in items]
    return success_response(data=payload)


@router.get("/{composite_id}")
def get_composite(
    composite_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    composite = services.get(db, composite_id)
    if composite is None:
        return not_found_response(f"Composite not found: {composite_id}")
    if not actor.workspace.virtual and not services.is_visible_to(
        db, composite, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    return success_response(data=CompositeReportRead.model_validate(composite))


@router.post("")
def create_composite(
    payload: CompositeReportCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    if actor.workspace.virtual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Cannot create composite in a virtual workspace; switch to a real workspace.",
        )
    # The user can write to their current workspace tree; reject other trees.
    scope = ws_services.get_descendants_inclusive(db, actor.workspace.slug)
    if payload.workspace_slug not in scope:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "종합보고는 현재 부서 또는 하위 부서에만 작성할 수 있습니다.",
        )
    try:
        composite = services.create(db, payload, owner_user_id=actor.user.id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=CompositeReportRead.model_validate(composite))


@router.patch("/{composite_id}")
def update_composite(
    composite_id: int,
    payload: CompositeReportUpdate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    composite = services.get(db, composite_id)
    if composite is None:
        return not_found_response(f"Composite not found: {composite_id}")
    if not actor.workspace.virtual and not services.is_visible_to(
        db, composite, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    try:
        composite = services.update(
            db, composite, payload, updated_by_user_id=actor.user.id
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(data=CompositeReportRead.model_validate(composite))


@router.delete("/{composite_id}")
def delete_composite(
    composite_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    composite = services.get(db, composite_id)
    if composite is None:
        return not_found_response(f"Composite not found: {composite_id}")
    if not actor.workspace.virtual and not services.is_visible_to(
        db, composite, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    services.delete(db, composite)
    return success_response(data=None, message="Deleted")
