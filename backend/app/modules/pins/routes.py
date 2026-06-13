"""부서 고정 보고서(핀) 라우트.

  GET    /api/workspaces/{slug}/pins            부서 핀 목록(멤버)
  POST   /api/workspaces/{slug}/pins {report_id} 고정(매니저)
  DELETE /api/workspaces/{slug}/pins/{report_id} 해제(매니저)

부서 단위 공용 핀 — 매니저(또는 시스템 관리자)가 관리하고 멤버는 본다.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.pins import models as _models  # noqa: F401
from app.modules.pins import services
from app.modules.reports.models import Report
from app.modules.reports.schemas import ReportSummary
from app.modules.users.models import Role
from app.shared.auth import CurrentUser, _resolve_role, get_current_user
from app.shared.responses import (
    created_response,
    error_response,
    success_response,
)


router = APIRouter()


class PinCreate(BaseModel):
    report_id: int


def _role_for(db: Session, actor: CurrentUser, slug: str) -> Role | None:
    if actor.user.is_system_admin:
        return Role.manager
    return _resolve_role(db, actor.user.id, slug)


def _require_member(db: Session, actor: CurrentUser, slug: str):
    if _role_for(db, actor, slug) is None:
        return error_response("부서 접근 권한이 없습니다.", status_code=403)
    return None


def _require_manager(db: Session, actor: CurrentUser, slug: str):
    if _role_for(db, actor, slug) != Role.manager:
        return error_response("부서 매니저만 고정할 수 있습니다.", status_code=403)
    return None


@router.get("/{workspace_slug}/pins")
def list_workspace_pins(
    workspace_slug: str,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    denied = _require_member(db, actor, workspace_slug)
    if denied:
        return denied
    pins = services.list_pins(db, workspace_slug)
    payload = []
    for pin in pins:
        report = db.get(Report, pin.report_id)
        # 삭제(휴지통)된 보고서는 핀에서 숨긴다.
        if report is None or getattr(report, "deleted_at", None) is not None:
            continue
        payload.append(ReportSummary.model_validate(report).model_dump(mode="json"))
    return success_response(data=payload)


@router.post("/{workspace_slug}/pins")
def add_workspace_pin(
    workspace_slug: str,
    body: PinCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    denied = _require_manager(db, actor, workspace_slug)
    if denied:
        return denied
    try:
        services.add_pin(db, workspace_slug, body.report_id, actor.user.id)
    except services.PinError as e:
        return error_response(e.message, status_code=e.status_code)
    return created_response(data={"pinned": True})


@router.delete("/{workspace_slug}/pins/{report_id}")
def remove_workspace_pin(
    workspace_slug: str,
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    denied = _require_manager(db, actor, workspace_slug)
    if denied:
        return denied
    services.remove_pin(db, workspace_slug, report_id)
    return success_response(data={"pinned": False})
