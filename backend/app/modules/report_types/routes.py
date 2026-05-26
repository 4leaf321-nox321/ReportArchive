"""Report types routes.

System-wide controlled vocabulary. Visibility rules:
- Anyone authenticated can list visible types (official + own unofficial)
  and create a new one (always lands as unofficial unless caller is admin).
- Admin endpoints (list-all, update, promote/demote, delete) require
  admin role *in any workspace* — mirrors VOC's "global admin" check
  since report types are not workspace-scoped.

Auth doesn't require the X-Workspace-Slug header so the admin tab can
load this without picking a workspace first.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.report_types import services
from app.modules.report_types.schemas import (
    ReportTypeCreate,
    ReportTypeListResponse,
    ReportTypeRead,
    ReportTypeUpdate,
)
from app.modules.users.models import Role, User, WorkspaceMember
from app.shared.auth import _resolve_user_from_token, bearer_scheme
from app.shared.responses import (
    created_response,
    not_found_response,
    success_response,
)

router = APIRouter()


@dataclass
class ReportTypeActor:
    user: User
    is_admin: bool


def report_type_actor(
    db: Session = Depends(get_db),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    _x_workspace_slug: Optional[str] = Header(default=None, alias="X-Workspace-Slug"),
) -> ReportTypeActor:
    """Auth dep — no workspace required. `is_admin` = SYSTEM admin
    (User.is_system_admin). Report types are org-wide vocabulary; only
    system admins promote/demote between official/unofficial. Any
    member can still create a new unofficial type."""
    user = _resolve_user_from_token(db, credentials)
    return ReportTypeActor(user=user, is_admin=user.is_system_admin)


def _require_system_admin(actor: ReportTypeActor) -> None:
    if not actor.is_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "관리자만 가능한 작업입니다."
        )


@router.get("")
def list_types(
    q: Optional[str] = Query(default=None, max_length=128),
    limit: int = Query(default=200, ge=1, le=500),
    actor: ReportTypeActor = Depends(report_type_actor),
    db: Session = Depends(get_db),
):
    """List for the picker — official + own unofficial (admin sees all)."""
    rows = services.list_visible(
        db, user_id=actor.user.id, is_admin=actor.is_admin, q=q, limit=limit
    )
    return success_response(
        data=ReportTypeListResponse(
            items=[ReportTypeRead.model_validate(r) for r in rows]
        )
    )


@router.get("/all")
def list_all(
    q: Optional[str] = Query(default=None, max_length=128),
    limit: int = Query(default=500, ge=1, le=1000),
    actor: ReportTypeActor = Depends(report_type_actor),
    db: Session = Depends(get_db),
):
    """Admin tab — full list including unofficial from any user."""
    _require_system_admin(actor)
    rows = services.list_all_for_admin(db, q=q, limit=limit)
    return success_response(
        data=ReportTypeListResponse(
            items=[ReportTypeRead.model_validate(r) for r in rows]
        )
    )


@router.post("", status_code=201)
def create_type(
    payload: ReportTypeCreate,
    actor: ReportTypeActor = Depends(report_type_actor),
    db: Session = Depends(get_db),
):
    try:
        row = services.create(
            db,
            payload,
            creator_user_id=actor.user.id,
            is_admin=actor.is_admin,
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=ReportTypeRead.model_validate(row))


@router.patch("/{type_id}")
def update_type(
    type_id: int,
    payload: ReportTypeUpdate,
    actor: ReportTypeActor = Depends(report_type_actor),
    db: Session = Depends(get_db),
):
    row = services.get(db, type_id)
    if not row:
        return not_found_response(f"보고서 종류를 찾을 수 없습니다: {type_id}")
    # Edit privileges: admin always; otherwise only the creator of a
    # still-unofficial entry can rename/edit their own draft. Once a
    # type is official, only admins edit it.
    is_owner_unofficial = (
        row.status.value == "unofficial"
        and row.created_by_user_id == actor.user.id
    )
    if not (actor.is_admin or is_owner_unofficial):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "이 종류를 수정할 권한이 없습니다.")
    try:
        row = services.update(db, row, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(data=ReportTypeRead.model_validate(row))


@router.post("/{type_id}/promote")
def promote_type(
    type_id: int,
    actor: ReportTypeActor = Depends(report_type_actor),
    db: Session = Depends(get_db),
):
    _require_system_admin(actor)
    row = services.get(db, type_id)
    if not row:
        return not_found_response(f"보고서 종류를 찾을 수 없습니다: {type_id}")
    row = services.promote(db, row, approver_user_id=actor.user.id)
    return success_response(data=ReportTypeRead.model_validate(row))


@router.post("/{type_id}/demote")
def demote_type(
    type_id: int,
    actor: ReportTypeActor = Depends(report_type_actor),
    db: Session = Depends(get_db),
):
    _require_system_admin(actor)
    row = services.get(db, type_id)
    if not row:
        return not_found_response(f"보고서 종류를 찾을 수 없습니다: {type_id}")
    row = services.demote(db, row)
    return success_response(data=ReportTypeRead.model_validate(row))


@router.delete("/{type_id}")
def delete_type(
    type_id: int,
    actor: ReportTypeActor = Depends(report_type_actor),
    db: Session = Depends(get_db),
):
    _require_system_admin(actor)
    row = services.get(db, type_id)
    if not row:
        return not_found_response(f"보고서 종류를 찾을 수 없습니다: {type_id}")
    name = row.name
    orphan_count = services.delete(db, row)
    msg = (
        f"'{name}' 삭제. {orphan_count}건의 보고서가 이 종류를 참조 중이었습니다 (연결 해제됨)."
        if orphan_count
        else f"'{name}' 삭제 완료."
    )
    return success_response(data={"orphan_report_count": orphan_count}, message=msg)
