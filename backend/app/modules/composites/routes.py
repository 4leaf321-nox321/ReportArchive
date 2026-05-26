"""Composite report routes."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.composites import services
from app.modules.composites.schemas import (
    CompositeRef,
    CompositeReportCreate,
    CompositeReportRead,
    CompositeReportSummary,
    CompositeReportUpdate,
)
from app.modules.reports import services as report_services
from app.modules.workspaces import services as ws_services
from app.shared.auth import CurrentUser, get_current_user, require_writer
from app.shared.responses import (
    created_response,
    not_found_response,
    success_response,
)

router = APIRouter()


@router.get("/by-report/{report_id}")
def list_composites_containing_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Every composite that references the given report as an item.
    Backs the report-detail "포함된 종합 N개" chip (Phase 5C 양방향 네비).

    Visibility: anyone who can see the report can see what composites
    it's in (otherwise the chip count would be hidden context). The
    composites themselves still scope-check on click — clicking a chip
    that the user can't open lands on a 403 from the composite detail
    route, not silently masked here."""
    report = report_services.get_report(db, report_id)
    if report is None:
        return success_response(data=[])
    if not actor.workspace.virtual and not report_services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    items = services.list_containing_report(db, report_id)
    payload = [CompositeRef.model_validate(c) for c in items]
    return success_response(data=payload)


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


# --------------------------------------------------------------------------- #
# Publish / unpublish — Phase 5A                                              #
# --------------------------------------------------------------------------- #


def _resolve_publishable(
    db: Session, composite_id: int, actor: CurrentUser
):
    """Shared guard: composite exists, visible to actor's workspace, and
    actor owns it (system admin overrides via user.is_system_admin)."""
    composite = services.get(db, composite_id)
    if composite is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Composite not found: {composite_id}",
        )
    if not actor.workspace.virtual and not services.is_visible_to(
        db, composite, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    is_owner = composite.owner_user_id == actor.user.id
    is_sys_admin = bool(getattr(actor.user, "is_system_admin", False))
    if not (is_owner or is_sys_admin):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "발행/발행 취소는 종합보고 작성자(또는 시스템 관리자)만 가능합니다.",
        )
    return composite


@router.post("/{composite_id}/publish")
def publish_composite(
    composite_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Owner-only: stamp `published_at` and (for recurring) freeze every
    item's content into `snapshot_content`. Idempotent — already-
    published returns 200 with the current state."""
    composite = _resolve_publishable(db, composite_id, actor)
    composite = services.publish(db, composite, actor_user_id=actor.user.id)
    return success_response(data=CompositeReportRead.model_validate(composite))


@router.post("/{composite_id}/unpublish")
def unpublish_composite(
    composite_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Owner-only: clear `published_at` and per-item snapshots so the
    composite returns to live-fetch + editable mode. Idempotent."""
    composite = _resolve_publishable(db, composite_id, actor)
    composite = services.unpublish(db, composite, actor_user_id=actor.user.id)
    return success_response(data=CompositeReportRead.model_validate(composite))
