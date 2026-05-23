"""Report routes — CRUD scoped to the actor's workspace tree."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.reports import services
from app.modules.reports.schemas import (
    LockInfo,
    ReportCreate,
    ReportRead,
    ReportSummary,
    ReportUpdate,
)
from app.shared.auth import CurrentUser, get_current_user, require_writer
from app.shared.responses import (
    created_response,
    error_response,
    not_found_response,
    success_response,
)

router = APIRouter()


def _lock_conflict_response(exc: services.LockError):
    """Translate a service-layer LockError into a 409 in the standard
    {success, message, errors} envelope. `errors[0]` carries a stable
    `code` string the frontend dispatches on; `holder` (when known) lets
    the takeover dialog render '현재 OO 편집 중' without a re-fetch.
    """
    detail: dict = {"code": exc.code, "message": str(exc)}
    if exc.holder is not None:
        detail["holder"] = LockInfo.model_validate({
            "user_id": exc.holder.user_id,
            "user_name": getattr(exc.holder.user, "name", None),
            "user_email": getattr(exc.holder.user, "email", None),
            "acquired_at": exc.holder.acquired_at,
            "expires_at": exc.holder.expires_at,
        }).model_dump(mode="json")
    return error_response(str(exc), errors=[detail], status_code=409)


@router.get("")
def list_reports(
    entity_ids: list[int] | None = Query(default=None, alias="entity_ids"),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """List reports in the actor's workspace tree.

    Optional `entity_ids` (repeated) applies the N-axis tag filter:
    OR within an axis, AND across axes. Sent by the list-page filter
    bar; absent for the default unfiltered view.
    """
    reports = services.list_reports_in_workspace(
        db,
        actor.workspace.slug,
        is_global_view=actor.workspace.virtual,
        entity_ids=entity_ids,
    )
    payload = [ReportSummary.model_validate(r) for r in reports]
    return success_response(data=payload)


@router.get("/{report_id}")
def get_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not actor.workspace.virtual and not services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    return success_response(data=ReportRead.model_validate(report))


@router.post("")
def create_report(
    payload: ReportCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    if actor.workspace.virtual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Cannot create report in a virtual workspace; switch to a real workspace.",
        )
    try:
        report = services.create_report(
            db, actor.workspace.slug, payload, owner_user_id=actor.user.id
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=ReportRead.model_validate(report))


@router.patch("/{report_id}")
def update_report(
    report_id: int,
    payload: ReportUpdate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not actor.workspace.virtual and not services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    try:
        report = services.update_report(
            db,
            report,
            payload,
            updated_by_user_id=actor.user.id,
            expected_revision=payload.expected_revision,
        )
    except services.LockError as exc:
        return _lock_conflict_response(exc)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(data=ReportRead.model_validate(report))


# --------------------------------------------------------------------------- #
# Edit lock endpoints                                                         #
# --------------------------------------------------------------------------- #


def _resolve_writable_report(
    db: Session, report_id: int, actor: CurrentUser
):
    """Shared guard for the three lock endpoints. Returns the report or
    raises the standard 404/403. Kept inline (not a Depends) because all
    three handlers need to surface the report object itself."""
    report = services.get_report(db, report_id)
    if not report:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"Report not found: {report_id}"
        )
    if not actor.workspace.virtual and not services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    return report


@router.post("/{report_id}/lock")
def acquire_lock(
    report_id: int,
    force: bool = Query(default=False),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Claim or refresh the edit lock. Pass `?force=true` to override an
    existing live lock (the previous holder will fail their next heartbeat
    / save and be bounced back to view mode)."""
    report = _resolve_writable_report(db, report_id, actor)
    try:
        lock = services.acquire_lock(db, report, actor.user.id, force=force)
    except services.LockError as exc:
        return _lock_conflict_response(exc)
    db.commit()
    db.refresh(report)
    info = LockInfo.model_validate({
        "user_id": lock.user_id,
        "user_name": actor.user.name,
        "user_email": actor.user.email,
        "acquired_at": lock.acquired_at,
        "expires_at": lock.expires_at,
    })
    return success_response(data=info)


@router.post("/{report_id}/lock/heartbeat")
def heartbeat_lock(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Extend the caller's lock TTL. Returns 409 if the caller doesn't hold
    a live lock — the frontend treats that as "you got bumped" and exits
    edit mode."""
    report = _resolve_writable_report(db, report_id, actor)
    try:
        lock = services.heartbeat_lock(db, report, actor.user.id)
    except services.LockError as exc:
        return _lock_conflict_response(exc)
    db.commit()
    info = LockInfo.model_validate({
        "user_id": lock.user_id,
        "user_name": actor.user.name,
        "user_email": actor.user.email,
        "acquired_at": lock.acquired_at,
        "expires_at": lock.expires_at,
    })
    return success_response(data=info)


@router.delete("/{report_id}/lock")
def release_lock(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Drop the lock. Idempotent — releases for non-holders or already-
    expired locks return 200 with a no-op so the frontend can fire-and-
    forget from beforeunload handlers."""
    report = _resolve_writable_report(db, report_id, actor)
    services.release_lock(db, report, actor.user.id)
    db.commit()
    return success_response(data=None, message="Released")


@router.delete("/{report_id}")
def delete_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not actor.workspace.virtual and not services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    services.delete_report(db, report)
    return success_response(data=None, message="Deleted")
