"""Entity tagging routes.

Two surfaces in one module:
  - `/api/entity-types`  — read-only axis catalog (system-managed)
  - `/api/entities`      — picker reads + user-can-add + admin-only edits

The link table (report ↔ entity) is NOT exposed here as its own
endpoint. Reports embed `entity_ids` in their normal PATCH /api/reports/{id}
payload (handled by reports/services.py); this keeps a single
revision-protected round-trip per save.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.entities import services
from app.modules.entities.schemas import (
    EntityCreate,
    EntityListResponse,
    EntityMergeRequest,
    EntityRead,
    EntityTypeListResponse,
    EntityTypeRead,
    EntityUpdate,
    EntityUsageReportRef,
    EntityUsageResponse,
)
from app.modules.users.models import Role, User, WorkspaceMember
from app.shared.auth import _resolve_user_from_token, bearer_scheme
from app.shared.responses import (
    created_response,
    error_response,
    not_found_response,
    success_response,
)


# --------------------------------------------------------------------------- #
# Auth dep — no workspace required. `is_admin` here means SYSTEM admin
# (User.is_system_admin), since entity master data is org-wide
# infrastructure. 부서 관리자 (workspace admin) can still *use* entity
# tags on reports; only system admins can edit the underlying vocabulary.
# --------------------------------------------------------------------------- #
@dataclass
class EntityActor:
    user: User
    is_admin: bool


def entity_actor(
    db: Session = Depends(get_db),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    _x_workspace_slug: Optional[str] = Header(default=None, alias="X-Workspace-Slug"),
) -> EntityActor:
    user = _resolve_user_from_token(db, credentials)
    return EntityActor(user=user, is_admin=user.is_system_admin)


def _require_admin(actor: EntityActor) -> None:
    if not actor.is_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "관리자만 가능한 작업입니다."
        )


def _to_read(row, usage_count: Optional[int] = None) -> EntityRead:
    """Hand-flatten `type_slug` from the joined EntityType — Pydantic's
    `from_attributes` can't walk a relationship into a sibling field by
    itself. `usage_count` is None for picker reads, an int for admin
    reads (when the route requested `with_usage=true`)."""
    return EntityRead(
        id=row.id,
        type_id=row.type_id,
        type_slug=row.entity_type.slug if row.entity_type else "",
        value=row.value,
        code=row.code,
        description=row.description,
        status=row.status,
        created_by_user_id=row.created_by_user_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
        usage_count=usage_count,
    )


# --------------------------------------------------------------------------- #
# entity-types router — `/api/entity-types`
# --------------------------------------------------------------------------- #
entity_types_router = APIRouter()


@entity_types_router.get("")
def list_entity_types(
    _actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """All 7 axes. Auth required (so anonymous probes can't enumerate
    the taxonomy), but no role gate."""
    rows = services.list_types(db)
    return success_response(
        data=EntityTypeListResponse(
            items=[EntityTypeRead.model_validate(r) for r in rows]
        )
    )


# --------------------------------------------------------------------------- #
# entities router — `/api/entities`
# --------------------------------------------------------------------------- #
entities_router = APIRouter()


@entities_router.get("")
def list_entities(
    type_id: Optional[int] = Query(default=None),
    q: Optional[str] = Query(default=None, max_length=128),
    include_deprecated: bool = Query(default=False),
    limit: int = Query(default=200, ge=1, le=500),
    with_usage: bool = Query(default=False),
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Picker list. Defaults to active-only; admin page passes
    `include_deprecated=true`. Without `type_id` returns across all
    axes (mostly useful for global search).

    `with_usage=true` is admin-only — it adds a per-row COUNT subquery
    to populate `usage_count`. We gate it on role to keep the picker
    path lean and to avoid leaking "this value is used by N reports"
    to non-admins (a minor info-disclosure, but trivial to gate)."""
    if with_usage and not actor.is_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "with_usage 는 관리자만 사용할 수 있습니다."
        )
    rows = services.list_entities(
        db,
        type_id=type_id,
        q=q,
        include_deprecated=include_deprecated,
        limit=limit,
        with_usage=with_usage,
    )
    if with_usage:
        items = [_to_read(r, usage_count=cnt) for (r, cnt) in rows]
    else:
        items = [_to_read(r) for r in rows]
    return success_response(data=EntityListResponse(items=items))


@entities_router.post("", status_code=201)
def create_entity(
    payload: EntityCreate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Any authenticated user can add. Pre-existing same-value rows are
    returned as-is (the service collapses the dup to a single canonical
    row) — picker treats either response as success."""
    try:
        row = services.create_entity(
            db, payload, creator_user_id=actor.user.id
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=_to_read(row))


@entities_router.patch("/{entity_id}")
def update_entity(
    entity_id: int,
    payload: EntityUpdate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    _require_admin(actor)
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    try:
        row = services.update_entity(db, row, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(data=_to_read(row))


@entities_router.post("/{entity_id}/merge")
def merge_entity(
    entity_id: int,
    payload: EntityMergeRequest,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Re-link all reports from `entity_id` to `payload.into_id`, drop
    the source. Admin only — fixing user-introduced duplicates is the
    primary use case."""
    _require_admin(actor)
    src = services.get_entity(db, entity_id)
    if not src:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    into = services.get_entity(db, payload.into_id)
    if not into:
        return not_found_response(
            f"머지 대상 엔티티를 찾을 수 없습니다: {payload.into_id}"
        )
    try:
        relinked = services.merge_entities(db, src=src, into=into)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(
        data={"relinked_report_count": relinked, "into_id": into.id},
        message=f"'{src.value}' → '{into.value}' 머지 완료. {relinked}건 재연결.",
    )


@entities_router.get("/{entity_id}/usage")
def list_entity_usage(
    entity_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only. Returns the slim list of reports currently tagged with
    this entity — used by the admin page's delete/merge dialogs and the
    "사용 N건" cell popover to surface which reports are blocking a
    destructive action. Workspace-agnostic on purpose: the admin needs
    to see all blockers, not just ones in their current workspace tree."""
    _require_admin(actor)
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    items = services.list_reports_using_entity(db, entity_id=entity_id)
    return success_response(
        data=EntityUsageResponse(
            items=[
                EntityUsageReportRef(
                    id=r_id,
                    title=title,
                    workspace_slug=ws,
                    updated_at=updated_at,
                )
                for (r_id, title, ws, updated_at) in items
            ]
        )
    )


@entities_router.delete("/{entity_id}/usage/{report_id}")
def unlink_one_report(
    entity_id: int,
    report_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — drop the (entity, report) link from the M:N table.
    The entity row itself stays. Idempotent: removing a link that doesn't
    exist still returns 200 (the desired state already holds)."""
    _require_admin(actor)
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    removed = services.unlink_from_report(
        db, entity_id=entity_id, report_id=report_id
    )
    return success_response(
        data={"removed": removed, "report_id": report_id},
        message=(
            f"보고서 {report_id} 에서 '{row.value}' 태그 해제됨."
            if removed
            else f"보고서 {report_id} 에는 '{row.value}' 태그가 없었습니다."
        ),
    )


@entities_router.delete("/{entity_id}/usage")
def unlink_all_reports(
    entity_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — drop every link this entity has across all reports.
    Bulk version of the per-report unlink above. After this runs the
    entity has 0 usage and can be hard-deleted via the regular endpoint.
    Returns the number of links removed."""
    _require_admin(actor)
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    count = services.unlink_from_all_reports(db, entity_id=entity_id)
    return success_response(
        data={"removed_count": count},
        message=f"{count}건의 보고서에서 '{row.value}' 태그 해제됨.",
    )


@entities_router.delete("/{entity_id}")
def delete_entity(
    entity_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Hard delete. Blocked when the entity is in use — the route
    surfaces a 400 so the admin can pick merge/deprecate instead."""
    _require_admin(actor)
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    name = row.value
    try:
        services.delete_entity(db, row)
    except ValueError as exc:
        return error_response(str(exc), status_code=400)
    return success_response(data=None, message=f"'{name}' 삭제 완료.")
