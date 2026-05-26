"""Mount routes — promote reports from personal space to org boards.

Phase 1 endpoints:

  * GET    /api/mounts?report_id=N  — list mounts for one report
                                       (used by the report header to
                                       show "현재 게시된 N개 게시판")
  * POST   /api/mounts               — mount a report to one or more
                                       boards (multi-target single call)
  * DELETE /api/mounts/{report_id}/{workspace_slug}
                                     — unmount from one board
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.mounts import models as _models  # noqa: F401
from app.modules.mounts import services
from app.modules.mounts.schemas import (
    MountCreate,
    MountEditPolicyUpdate,
    MountFolderUpdate,
    MountListResponse,
    MountRead,
    UnmountResponse,
)
from app.shared.auth import CurrentUser, get_current_user
from app.shared.responses import error_response, success_response


router = APIRouter()


def _to_http(exc: services.MountError):
    return error_response(
        str(exc), errors=[{"code": exc.code}], status_code=exc.status_code
    )


@router.get("")
def list_mounts(
    report_id: int = Query(...),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """List every board this report is mounted on.

    Visibility: anyone who can see the report (via personal ownership
    or via an existing mount in their workspace tree) can list its
    mounts. Phase 1 returns the raw list without that filter — it's
    metadata anyone with the report id already saw to ask the question.
    """
    rows = services.list_mounts_for_report(db, report_id)
    payload = MountListResponse(items=[MountRead.model_validate(r) for r in rows])
    return success_response(data=payload.model_dump(mode="json"))


@router.post("")
def create_mount(
    payload: MountCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Mount a report to one or more org boards.

    Idempotent per-board: already-mounted targets are silently skipped.
    Response carries only newly-created mounts.
    """
    try:
        created = services.mount_report(
            db,
            report_id=payload.report_id,
            workspace_slugs=payload.workspace_slugs,
            actor_user_id=actor.user.id,
            edit_policy=payload.edit_policy,
            note=payload.note,
            folder_id=payload.folder_id,
        )
    except services.MountError as e:
        return _to_http(e)
    db.commit()
    items = [MountRead.model_validate(m) for m in created]
    return success_response(
        data=MountListResponse(items=items).model_dump(mode="json")
    )


@router.put("/{report_id}/{workspace_slug}/folder")
def set_mount_folder(
    report_id: int,
    workspace_slug: str,
    payload: MountFolderUpdate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Metadata-only move of a mount between org folders. Permission:
    report owner OR the user who mounted it OR workspace admin/manager."""
    try:
        services.set_mount_folder(
            db,
            report_id=report_id,
            workspace_slug=workspace_slug,
            folder_id=payload.folder_id,
            actor_user_id=actor.user.id,
        )
    except services.MountError as e:
        return _to_http(e)
    db.commit()
    return success_response(
        data={
            "report_id": report_id,
            "workspace_slug": workspace_slug,
            "folder_id": payload.folder_id,
        }
    )


@router.put("/{report_id}/{workspace_slug}/edit-policy")
def set_mount_edit_policy(
    report_id: int,
    workspace_slug: str,
    payload: MountEditPolicyUpdate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Change the per-board edit policy. Owner-only (Phase 3)."""
    try:
        services.set_mount_edit_policy(
            db,
            report_id=report_id,
            workspace_slug=workspace_slug,
            edit_policy=payload.edit_policy,
            actor_user_id=actor.user.id,
        )
    except services.MountError as e:
        return _to_http(e)
    db.commit()
    return success_response(
        data={
            "report_id": report_id,
            "workspace_slug": workspace_slug,
            "edit_policy": payload.edit_policy.value,
        }
    )


@router.delete("/{report_id}/{workspace_slug}")
def delete_mount(
    report_id: int,
    workspace_slug: str,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Unmount a report from one board. Permission: report owner OR
    workspace admin on the board.
    """
    try:
        services.unmount_report(
            db,
            report_id=report_id,
            workspace_slug=workspace_slug,
            actor_user_id=actor.user.id,
        )
    except services.MountError as e:
        return _to_http(e)
    db.commit()
    return success_response(
        data=UnmountResponse(
            report_id=report_id, workspace_slug=workspace_slug
        ).model_dump(mode="json")
    )
