"""Composite report routes."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.composites import services
from app.modules.composites.models import CompositeItemRequestStatus
from app.modules.composites.schemas import (
    CompositeItemRequestCreate,
    CompositeItemRequestRead,
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
    except services.CompositeError as exc:
        # CompositeConflictError(409) 등 — 각자의 status_code 로 매핑.
        raise HTTPException(exc.status_code, str(exc)) from exc
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


# --------------------------------------------------------------------------- #
# 안건 제출(신청) 큐 — 보고서 → 종합보고 수집 (동시편집 회피)                  #
# --------------------------------------------------------------------------- #


def _resolve_visible(db, composite_id: int, actor: CurrentUser):
    """composite 존재 + actor 워크스페이스에서 가시. 제출/조회 공통 가드."""
    composite = services.get(db, composite_id)
    if composite is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"Composite not found: {composite_id}"
        )
    if not actor.workspace.virtual and not services.is_visible_to(
        db, composite, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    return composite


def _resolve_owner(db, composite_id: int, actor: CurrentUser):
    """승인/반려 가드 — owner(또는 시스템 관리자)만."""
    composite = _resolve_visible(db, composite_id, actor)
    is_owner = composite.owner_user_id == actor.user.id
    is_sys_admin = bool(getattr(actor.user, "is_system_admin", False))
    if not (is_owner or is_sys_admin):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "제출 승인/반려는 종합보고 작성자(또는 시스템 관리자)만 가능합니다.",
        )
    return composite


@router.get("/submittable-for/{report_id}")
def list_submittable_composites(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """이 보고서를 안건으로 제출할 수 있는 종합보고 목록 + 상태 플래그
    (이미 안건 / 이미 제출 대기). 보고서 상세의 "종합보고에 제출" 다이얼로그용."""
    report = report_services.get_report(db, report_id)
    if report is None:
        return success_response(data=[])
    if not actor.workspace.virtual and not report_services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    comps = services.list_submittable_composites(db, report)
    out = []
    for c in comps:
        already_item = any(
            it.ref_report_id == report_id for it in c.items
        )
        pending = services.list_item_requests(
            db, c, status=CompositeItemRequestStatus.pending
        )
        already_pending = any(r.ref_report_id == report_id for r in pending)
        out.append(
            {
                "id": c.id,
                "workspace_slug": c.workspace_slug,
                "title": c.title,
                "kind": c.kind.value if hasattr(c.kind, "value") else c.kind,
                "period_date": c.period_date,
                "owner_user_id": c.owner_user_id,
                "owner_name": c.owner.name if c.owner else None,
                "published_at": c.published_at,
                "already_item": already_item,
                "already_pending": already_pending,
            }
        )
    return success_response(data=out)


@router.post("/{composite_id}/requests")
def submit_item_request(
    composite_id: int,
    payload: CompositeItemRequestCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """보고서를 이 종합보고에 안건으로 제출. 제출자는 그 보고서를 읽을 수
    있어야 한다(가시성). 종합보고는 직접 수정하지 않고 pending 만 쌓인다."""
    composite = _resolve_visible(db, composite_id, actor)
    report = report_services.get_report(db, payload.ref_report_id)
    if report is None:
        return not_found_response(f"Report not found: {payload.ref_report_id}")
    if not report_services.can_read_report(db, actor, report):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "제출하려는 보고서를 볼 권한이 없습니다."
        )
    try:
        req = services.submit_item_request(
            db,
            composite,
            payload.ref_report_id,
            note=payload.note,
            requested_by_user_id=actor.user.id,
        )
    except services.CompositeError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    return created_response(
        data=CompositeItemRequestRead.model_validate(req)
    )


@router.get("/{composite_id}/requests")
def list_item_requests(
    composite_id: int,
    status_filter: str | None = None,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """이 종합보고의 제출 요청 목록. 기본 pending 만; status_filter 로 변경."""
    composite = _resolve_visible(db, composite_id, actor)
    st = None
    if status_filter:
        try:
            st = CompositeItemRequestStatus(status_filter)
        except ValueError:
            st = None
    else:
        st = CompositeItemRequestStatus.pending
    reqs = services.list_item_requests(db, composite, status=st)
    return success_response(
        data=[CompositeItemRequestRead.model_validate(r) for r in reqs]
    )


def _resolve_request(db, composite_id: int, req_id: int):
    from app.modules.composites.models import CompositeItemRequest

    req = db.get(CompositeItemRequest, req_id)
    if req is None or req.composite_id != composite_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Request not found")
    return req


@router.post("/{composite_id}/requests/{req_id}/accept")
def accept_item_request(
    composite_id: int,
    req_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    _resolve_owner(db, composite_id, actor)
    req = _resolve_request(db, composite_id, req_id)
    try:
        req = services.accept_item_request(
            db, req, decided_by_user_id=actor.user.id
        )
    except services.CompositeError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    return success_response(data=CompositeItemRequestRead.model_validate(req))


@router.post("/{composite_id}/requests/{req_id}/reject")
def reject_item_request(
    composite_id: int,
    req_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    _resolve_owner(db, composite_id, actor)
    req = _resolve_request(db, composite_id, req_id)
    try:
        req = services.reject_item_request(
            db, req, decided_by_user_id=actor.user.id
        )
    except services.CompositeError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    return success_response(data=CompositeItemRequestRead.model_validate(req))


@router.post("/{composite_id}/requests/{req_id}/withdraw")
def withdraw_item_request(
    composite_id: int,
    req_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """제출 철회 — 제출자 본인(또는 종합보고 owner/시스템관리자)."""
    composite = _resolve_visible(db, composite_id, actor)
    req = _resolve_request(db, composite_id, req_id)
    is_requester = req.requested_by_user_id == actor.user.id
    is_owner = composite.owner_user_id == actor.user.id
    is_sys_admin = bool(getattr(actor.user, "is_system_admin", False))
    if not (is_requester or is_owner or is_sys_admin):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "본인 제출만 철회할 수 있습니다."
        )
    try:
        req = services.withdraw_item_request(db, req)
    except services.CompositeError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    return success_response(data=CompositeItemRequestRead.model_validate(req))
