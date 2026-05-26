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
    if workspace_slug:
        folders = services.list_org_folders(db, workspace_slug)
        uncategorized = services.count_uncategorized_org(db, workspace_slug)
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
    try:
        if workspace_slug:
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
            name=raw.get("name"),
            parent_id_set="parent_id" in raw,
            parent_id=raw.get("parent_id"),
            sort_order=raw.get("sort_order"),
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
            db, folder_id=folder_id, actor_user_id=actor.id
        )
    except services.FolderError as e:
        return _to_http(e)
    db.commit()
    return success_response(data={"id": folder_id})
