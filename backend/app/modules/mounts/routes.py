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
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.mounts import models as _models  # noqa: F401
from app.modules.mounts import services
from app.modules.mounts.schemas import (
    MountCreate,
    MountEditPolicyUpdate,
    MountFolderUpdate,
    MountListResponse,
    MountNoteUpdate,
    MountRead,
    TakedownRequestRead,
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
    # 표시용 이름 일괄 조회 — 게시판(Workspace) + 폴더(Folder).
    from app.modules.folders.models import Folder
    from app.modules.workspaces.models import Workspace

    ws_names = {
        slug: name
        for slug, name in db.execute(
            select(Workspace.slug, Workspace.name).where(
                Workspace.slug.in_([r.workspace_slug for r in rows] or [""])
            )
        ).all()
    }
    folder_ids = [r.folder_id for r in rows if r.folder_id is not None]
    folder_names = (
        {
            fid: name
            for fid, name in db.execute(
                select(Folder.id, Folder.name).where(Folder.id.in_(folder_ids))
            ).all()
        }
        if folder_ids
        else {}
    )
    # 이 보고서에 대해 pending 인 게시취소 요청이 걸린 게시판 slug 집합 —
    # 작성자가 개별 게시판에 "내리기 요청"을 보냈으나 아직 매니저가 처리하지
    # 않은 건. 프런트가 그 행을 "승인 대기"로 표시한다.
    pending_takedown_slugs = {
        slug
        for (slug,) in db.execute(
            select(_models.ReportTakedownRequest.workspace_slug).where(
                _models.ReportTakedownRequest.report_id == report_id,
                _models.ReportTakedownRequest.status
                == _models.TakedownStatus.pending,
            )
        ).all()
    }
    items = []
    for r in rows:
        mr = MountRead.model_validate(r)
        # 현재 사용자가 이 게시판에서 직접 게시취소 가능한지(매니저/시스템관리자).
        mr.can_unmount = services._can_unmount_board(
            db, actor.user.id, r.workspace_slug
        )
        mr.takedown_pending = r.workspace_slug in pending_takedown_slugs
        mr.workspace_name = ws_names.get(r.workspace_slug)
        mr.folder_name = (
            folder_names.get(r.folder_id) if r.folder_id is not None else None
        )
        items.append(mr)
    payload = MountListResponse(items=items)
    return success_response(data=payload.model_dump(mode="json"))


@router.get("/grant-board-slugs")
def list_grant_board_slugs(
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """게시 대화상자가 후보를 넓히는 데 쓰는 보조 목록 — 사용자가 멤버는
    아니지만 **편집 권한(board edit grant)이 열려 있어** 게시할 수 있는 게시판
    slug 들. 프론트는 이 집합을 멤버십 기반 후보에 합쳐(union) 표시한다.
    멤버십 게시판은 프론트가 이미 알고 있으므로 여기엔 grant 경로만 담는다."""
    from app.modules.grants import services as grant_services

    slugs = sorted(grant_services.boards_edit_reachable_slugs(db, actor.user.id))
    return success_response(data={"slugs": slugs})


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


@router.put("/{report_id}/{workspace_slug}/note")
def set_mount_note(
    report_id: int,
    workspace_slug: str,
    payload: MountNoteUpdate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """게시 메모 수정. 권한: 작성자 / 게시자 / 게시판 매니저."""
    try:
        row = services.set_mount_note(
            db,
            report_id=report_id,
            workspace_slug=workspace_slug,
            note=payload.note,
            actor_user_id=actor.user.id,
        )
    except services.MountError as e:
        return _to_http(e)
    db.commit()
    return success_response(
        data={
            "report_id": report_id,
            "workspace_slug": workspace_slug,
            "note": row.note,
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


# --------------------------------------------------------------------------- #
# 게시취소 요청 큐 (보고서 삭제 재설계 2단계) — /api/takedown-requests
# 매니저가 자기 게시판(/w/:slug/members)에서 보는 요청 큐. 요청 생성은
# reports 라우터의 POST /api/reports/{id}/takedown-requests 에 있다.
# --------------------------------------------------------------------------- #
takedown_router = APIRouter()


def _takedown_to_read(req) -> dict:
    return TakedownRequestRead(
        id=req.id,
        report_id=req.report_id,
        report_title=getattr(req.report, "title", None),
        workspace_slug=req.workspace_slug,
        workspace_name=getattr(req.workspace, "name", None),
        requested_by_name=getattr(req.requested_by, "name", None),
        status=req.status.value,
        created_at=req.created_at,
    ).model_dump()


@takedown_router.get("")
def list_takedowns(
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """현재 게시판(X-Workspace-Slug)에 들어온 pending 게시취소 요청 —
    그 게시판 매니저(조상 포함)/시스템관리자만."""
    try:
        rows = services.list_takedown_requests(
            db, workspace_slug=actor.workspace.slug, actor_user_id=actor.user.id
        )
    except services.MountError as exc:
        return _to_http(exc)
    return success_response(data=[_takedown_to_read(r) for r in rows])


@takedown_router.post("/{request_id}/approve")
def approve_takedown_request(
    request_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """승인 → 그 게시판에서 게시취소. 권한: 그 board 매니저/시스템관리자."""
    try:
        req = services.approve_takedown(
            db, request_id=request_id, actor_user_id=actor.user.id
        )
    except services.MountError as exc:
        return _to_http(exc)
    return success_response(data=_takedown_to_read(req), message="Approved")


@takedown_router.post("/{request_id}/reject")
def reject_takedown_request(
    request_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """거절 → 그 게시판 게시 유지(부서 보존). 권한: 그 board 매니저/시스템관리자."""
    try:
        req = services.reject_takedown(
            db, request_id=request_id, actor_user_id=actor.user.id
        )
    except services.MountError as exc:
        return _to_http(exc)
    return success_response(data=_takedown_to_read(req), message="Rejected")
