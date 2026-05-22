"""AI prompts routes.

System-wide catalog (like report_types). Visibility rules mirror that
module exactly so the admin UI and the picker can share their mental
model:

- Anyone authenticated can list visible prompts (official + own
  unofficial) and create a new one (always lands as unofficial unless
  the caller is admin).
- Admin endpoints (list-all, update of others' rows, promote/demote,
  delete) require admin role *in any workspace* — same broader
  granularity as VOC / report_types since prompts are not
  workspace-scoped.

Auth doesn't require the X-Workspace-Slug header so the /ai-settings
page can load this without picking a workspace first.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.prompts import services
from app.modules.prompts.schemas import (
    PromptCreate,
    PromptListResponse,
    PromptRead,
    PromptUpdate,
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
class PromptActor:
    user: User
    is_admin: bool


def prompt_actor(
    db: Session = Depends(get_db),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    _x_workspace_slug: Optional[str] = Header(default=None, alias="X-Workspace-Slug"),
) -> PromptActor:
    """Auth dep — no workspace required. is_admin = holds admin in any
    workspace (same broader granularity as VOC / report_types)."""
    user = _resolve_user_from_token(db, credentials)
    is_admin = (
        db.execute(
            select(WorkspaceMember.id)
            .where(
                WorkspaceMember.user_id == user.id,
                WorkspaceMember.role == Role.admin,
            )
            .limit(1)
        ).first()
        is not None
    )
    return PromptActor(user=user, is_admin=is_admin)


def _require_admin(actor: PromptActor) -> None:
    if not actor.is_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "관리자만 가능한 작업입니다."
        )


@router.get("")
def list_prompts(
    q: Optional[str] = Query(default=None, max_length=128),
    limit: int = Query(default=200, ge=1, le=500),
    actor: PromptActor = Depends(prompt_actor),
    db: Session = Depends(get_db),
):
    """List for the picker — official + own unofficial (admin sees all)."""
    rows = services.list_visible(
        db, user_id=actor.user.id, is_admin=actor.is_admin, q=q, limit=limit
    )
    return success_response(
        data=PromptListResponse(
            items=[PromptRead.model_validate(r) for r in rows]
        )
    )


@router.get("/all")
def list_all(
    q: Optional[str] = Query(default=None, max_length=128),
    limit: int = Query(default=500, ge=1, le=1000),
    actor: PromptActor = Depends(prompt_actor),
    db: Session = Depends(get_db),
):
    """Admin tab — full list including unofficial from any user."""
    _require_admin(actor)
    rows = services.list_all_for_admin(db, q=q, limit=limit)
    return success_response(
        data=PromptListResponse(
            items=[PromptRead.model_validate(r) for r in rows]
        )
    )


@router.get("/{prompt_id}")
def get_prompt(
    prompt_id: int,
    actor: PromptActor = Depends(prompt_actor),
    db: Session = Depends(get_db),
):
    """Single-row fetch — used when the picker opens an existing prompt
    to populate the body in the preview dialog. Visibility rules match
    the list endpoint: non-admins can only fetch official + own rows."""
    row = services.get(db, prompt_id)
    if not row:
        return not_found_response(f"프롬프트를 찾을 수 없습니다: {prompt_id}")
    if not actor.is_admin and row.status.value != "official":
        if row.created_by_user_id != actor.user.id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "이 프롬프트를 볼 권한이 없습니다."
            )
    return success_response(data=PromptRead.model_validate(row))


@router.post("", status_code=201)
def create_prompt(
    payload: PromptCreate,
    actor: PromptActor = Depends(prompt_actor),
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
    return created_response(data=PromptRead.model_validate(row))


@router.patch("/{prompt_id}")
def update_prompt(
    prompt_id: int,
    payload: PromptUpdate,
    actor: PromptActor = Depends(prompt_actor),
    db: Session = Depends(get_db),
):
    row = services.get(db, prompt_id)
    if not row:
        return not_found_response(f"프롬프트를 찾을 수 없습니다: {prompt_id}")
    # Edit privileges: admin always; otherwise only the creator of a
    # still-unofficial entry can rename/edit their own draft. Once a
    # prompt is official, only admins edit it.
    is_owner_unofficial = (
        row.status.value == "unofficial"
        and row.created_by_user_id == actor.user.id
    )
    if not (actor.is_admin or is_owner_unofficial):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "이 프롬프트를 수정할 권한이 없습니다."
        )
    try:
        row = services.update(db, row, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(data=PromptRead.model_validate(row))


@router.post("/{prompt_id}/promote")
def promote_prompt(
    prompt_id: int,
    actor: PromptActor = Depends(prompt_actor),
    db: Session = Depends(get_db),
):
    _require_admin(actor)
    row = services.get(db, prompt_id)
    if not row:
        return not_found_response(f"프롬프트를 찾을 수 없습니다: {prompt_id}")
    row = services.promote(db, row, approver_user_id=actor.user.id)
    return success_response(data=PromptRead.model_validate(row))


@router.post("/{prompt_id}/demote")
def demote_prompt(
    prompt_id: int,
    actor: PromptActor = Depends(prompt_actor),
    db: Session = Depends(get_db),
):
    _require_admin(actor)
    row = services.get(db, prompt_id)
    if not row:
        return not_found_response(f"프롬프트를 찾을 수 없습니다: {prompt_id}")
    row = services.demote(db, row)
    return success_response(data=PromptRead.model_validate(row))


@router.delete("/{prompt_id}")
def delete_prompt(
    prompt_id: int,
    actor: PromptActor = Depends(prompt_actor),
    db: Session = Depends(get_db),
):
    _require_admin(actor)
    row = services.get(db, prompt_id)
    if not row:
        return not_found_response(f"프롬프트를 찾을 수 없습니다: {prompt_id}")
    name = row.name
    services.delete(db, row)
    return success_response(data={"id": prompt_id}, message=f"'{name}' 삭제 완료.")
