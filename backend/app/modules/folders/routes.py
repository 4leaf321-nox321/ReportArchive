"""Folder routes — single endpoint family handles both scopes.

Scope is selected by the `workspace_slug` query param (or, for
mutation endpoints, by the folder's own `kind` once fetched):

  * GET /api/folders                       → personal scope (my own)
  * GET /api/folders?workspace_slug=팀1    → org scope for that board

POST/PATCH/DELETE: the same dispatch — for POST, presence of
`workspace_slug` query param picks scope; for PATCH/DELETE, the
folder's own scope is authoritative.

Permissions resolved entirely in services.py — routes just translate
errors.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.folders import models as _models  # noqa: F401
from app.modules.folders import services
from app.modules.folders.schemas import (
    FolderCreate,
    FolderListResponse,
    FolderRead,
    FolderUpdate,
)
from app.modules.users.models import User
from app.shared.auth import get_current_user_no_workspace
from app.shared.responses import (
    created_response,
    error_response,
    success_response,
)


router = APIRouter()


def _to_http(exc: services.FolderError):
    return error_response(
        str(exc), errors=[{"code": exc.code}], status_code=exc.status_code
    )


def _parse_personal_user_id(workspace_slug: str) -> Optional[int]:
    """personal-{N} slug → N. 그 외는 None. 시스템 관리자가 '가입자 공간'
    페이지로 다른 사람의 personal 워크스페이스를 들여다볼 때, 폴더 API
    가 actor 가 아니라 그 가입자의 폴더를 반환하도록 분기하기 위한 헬퍼."""
    prefix = "personal-"
    if not workspace_slug or not workspace_slug.startswith(prefix):
        return None
    try:
        return int(workspace_slug[len(prefix):])
    except ValueError:
        return None


@router.get("")
def list_folders(
    workspace_slug: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    """List folders. Personal if `workspace_slug` omitted, org otherwise.

    For org scope, any workspace member can read the tree (no admin
    requirement for read — admin is only for mutation). We don't gate
    reads here so a member can see "what folders my team is using"
    even before they have any reports mounted.
    """
    personal_target = _parse_personal_user_id(workspace_slug) if workspace_slug else None
    if personal_target is not None:
        # personal-{N} 슬러그 — N 의 개인 폴더. 본인이거나 시스템 관리자만.
        if personal_target != actor.id and not actor.is_system_admin:
            return error_response(
                "다른 가입자의 개인 폴더는 시스템 관리자만 조회할 수 있습니다.",
                status_code=403,
            )
        folders = services.list_personal_folders(db, personal_target)
        uncategorized = services.count_uncategorized_personal(db, personal_target)
    elif workspace_slug:
        # 비멤버 외부 열람자(조직간공개_설계 Phase 5)는 공개 폴더만 본다 —
        # 멤버/시스템관리자는 전체 트리. (default-create 부작용도 비멤버 경로는
        # 타지 않는다 — 남의 게시판에 기본 폴더를 만들면 안 되므로.)
        from app.shared.auth import _resolve_role

        is_member = (
            actor.is_system_admin
            or _resolve_role(db, actor.id, workspace_slug) is not None
        )
        if is_member:
            folders = services.list_org_folders(db, workspace_slug)
            uncategorized = services.count_uncategorized_org(db, workspace_slug)
        else:
            folders = services.list_public_org_folders(db, workspace_slug)
            uncategorized = services.count_public_uncategorized_org(
                db, workspace_slug
            )
    else:
        folders = services.list_personal_folders(db, actor.id)
        uncategorized = services.count_uncategorized_personal(db, actor.id)
    # list_*_folders has side effects (default-create). Commit so the
    # rows persist past this request — without it, next request would
    # see no folders and re-create defaults with new ids that PATCH
    # calls from this request's response can't reference.
    db.commit()
    payload = FolderListResponse(
        items=[FolderRead.model_validate(f) for f in folders],
        uncategorized_count=uncategorized,
    )
    return success_response(data=payload.model_dump(mode="json"))


@router.post("")
def create_folder(
    payload: FolderCreate,
    workspace_slug: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    personal_target = _parse_personal_user_id(workspace_slug) if workspace_slug else None
    try:
        if personal_target is not None:
            if personal_target != actor.id and not actor.is_system_admin:
                return error_response(
                    "다른 가입자의 개인 폴더는 시스템 관리자만 생성할 수 있습니다.",
                    status_code=403,
                )
            folder = services.create_personal_folder(
                db,
                user_id=personal_target,
                name=payload.name,
                parent_id=payload.parent_id,
                sort_order=payload.sort_order,
            )
        elif workspace_slug:
            folder = services.create_org_folder(
                db,
                workspace_slug=workspace_slug,
                actor_user_id=actor.id,
                name=payload.name,
                parent_id=payload.parent_id,
                sort_order=payload.sort_order,
            )
        else:
            folder = services.create_personal_folder(
                db,
                user_id=actor.id,
                name=payload.name,
                parent_id=payload.parent_id,
                sort_order=payload.sort_order,
            )
    except services.FolderError as e:
        return _to_http(e)
    db.commit()
    return created_response(
        data=FolderRead.model_validate(folder).model_dump(mode="json")
    )


@router.patch("/{folder_id}")
def update_folder(
    folder_id: int,
    payload: FolderUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    raw = payload.model_dump(exclude_unset=True)
    try:
        folder = services.update_folder(
            db,
            folder_id=folder_id,
            actor_user_id=actor.id,
            actor_is_system_admin=actor.is_system_admin,
            name=raw.get("name"),
            parent_id_set="parent_id" in raw,
            parent_id=raw.get("parent_id"),
            sort_order=raw.get("sort_order"),
            external_view_set="external_view" in raw,
            external_view=raw.get("external_view"),
        )
    except services.FolderError as e:
        return _to_http(e)
    db.commit()
    return success_response(
        data=FolderRead.model_validate(folder).model_dump(mode="json")
    )


@router.delete("/{folder_id}")
def delete_folder(
    folder_id: int,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    try:
        services.delete_folder(
            db,
            folder_id=folder_id,
            actor_user_id=actor.id,
            actor_is_system_admin=actor.is_system_admin,
        )
    except services.FolderError as e:
        return _to_http(e)
    db.commit()
    return success_response(data={"id": folder_id})
