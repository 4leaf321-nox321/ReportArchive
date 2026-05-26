"""Section taxonomy routes — list public to any authenticated user; write
admin-only. Mirrors widget_relations / template_categories."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.section_taxonomy import services
from app.modules.section_taxonomy.schemas import (
    SectionCategoryCreate,
    SectionCategoryRead,
    SectionCategoryUpdate,
    SectionItemCreate,
    SectionItemRead,
    SectionItemUpdate,
)
from app.modules.users.models import User
from app.shared.auth import (
    CurrentUser,
    get_current_user_no_workspace,
    require_system_admin,
)
from app.shared.responses import (
    created_response,
    not_found_response,
    success_response,
)

router = APIRouter()


# ---------------------------------------------------------------------- #
# Categories                                                              #
# ---------------------------------------------------------------------- #
@router.get("/categories")
def list_categories(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user_no_workspace),
):
    """Returns every category with its items embedded — the picker and
    badge resolver each need both, and the payload stays small enough
    (≤ 100 items total in practice) that a single fetch is cheaper than
    two."""
    items = [
        SectionCategoryRead.model_validate(c) for c in services.list_categories(db)
    ]
    return success_response(data=items)


@router.post("/categories")
def create_category(
    payload: SectionCategoryCreate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    try:
        cat = services.create_category(db, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=SectionCategoryRead.model_validate(cat))


@router.patch("/categories/{slug}")
def update_category(
    slug: str,
    payload: SectionCategoryUpdate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    cat = services.get_category(db, slug)
    if not cat:
        return not_found_response(f"분류를 찾을 수 없습니다: {slug}")
    cat = services.update_category(db, cat, payload)
    return success_response(data=SectionCategoryRead.model_validate(cat))


@router.delete("/categories/{slug}")
def delete_category(
    slug: str,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    cat = services.get_category(db, slug)
    if not cat:
        return not_found_response(f"분류를 찾을 수 없습니다: {slug}")
    services.delete_category(db, cat)
    return success_response(message=f"분류 '{slug}'을 삭제했습니다.")


# ---------------------------------------------------------------------- #
# Items                                                                   #
# ---------------------------------------------------------------------- #
@router.post("/items")
def create_item(
    payload: SectionItemCreate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    try:
        item = services.create_item(db, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=SectionItemRead.model_validate(item))


@router.patch("/items/{code}")
def update_item(
    code: str,
    payload: SectionItemUpdate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    item = services.get_item(db, code)
    if not item:
        return not_found_response(f"항목을 찾을 수 없습니다: {code}")
    try:
        item = services.update_item(db, item, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(data=SectionItemRead.model_validate(item))


@router.delete("/items/{code}")
def delete_item(
    code: str,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_system_admin),
):
    item = services.get_item(db, code)
    if not item:
        return not_found_response(f"항목을 찾을 수 없습니다: {code}")
    services.delete_item(db, item)
    return success_response(message=f"항목 '{code}'을 삭제했습니다.")
