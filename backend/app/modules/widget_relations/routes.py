"""Widget relation routes — read public to any authenticated user;
write admin-only. Mirrors template_categories."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.users.models import User
from app.modules.widget_relations import services
from app.modules.widget_relations.schemas import (
    RelationCreate,
    RelationRead,
    RelationUpdate,
)
from app.shared.auth import (
    CurrentUser,
    get_current_user_no_workspace,
    require_admin,
)
from app.shared.responses import (
    created_response,
    not_found_response,
    success_response,
)

router = APIRouter()


@router.get("")
def list_relations(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user_no_workspace),
):
    items = [RelationRead.model_validate(r) for r in services.list_relations(db)]
    return success_response(data=items)


@router.post("")
def create_relation(
    payload: RelationCreate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_admin),
):
    try:
        rel = services.create_relation(db, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=RelationRead.model_validate(rel))


@router.patch("/{slug}")
def update_relation(
    slug: str,
    payload: RelationUpdate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_admin),
):
    rel = services.get_relation(db, slug)
    if not rel:
        return not_found_response(f"관계를 찾을 수 없습니다: {slug}")
    rel = services.update_relation(db, rel, payload)
    return success_response(data=RelationRead.model_validate(rel))


@router.delete("/{slug}")
def delete_relation(
    slug: str,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_admin),
):
    rel = services.get_relation(db, slug)
    if not rel:
        return not_found_response(f"관계를 찾을 수 없습니다: {slug}")
    try:
        services.delete_relation(db, rel)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(message=f"관계 '{slug}'을 삭제했습니다.")
