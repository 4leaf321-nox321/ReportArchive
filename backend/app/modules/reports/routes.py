"""Report routes — CRUD scoped to the actor's workspace tree."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.reports import services
from app.modules.reports.schemas import (
    ReportCreate,
    ReportRead,
    ReportSummary,
    ReportUpdate,
)
from app.shared.auth import CurrentUser, get_current_user, require_writer
from app.shared.responses import (
    created_response,
    not_found_response,
    success_response,
)

router = APIRouter()


@router.get("")
def list_reports(
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    reports = services.list_reports_in_workspace(
        db, actor.workspace.slug, is_global_view=actor.workspace.virtual
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
        report = services.update_report(db, report, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(data=ReportRead.model_validate(report))


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
