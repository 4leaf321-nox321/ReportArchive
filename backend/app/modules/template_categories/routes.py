"""Template category routes — read public to any authenticated user;
write admin-only."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.template_categories import services
from app.modules.template_categories.schemas import (
    CategoryCreate,
    CategoryRead,
    CategoryUpdate,
)
from app.modules.users.models import User
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
def list_categories(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user_no_workspace),
):
    items = [CategoryRead.model_validate(c) for c in services.list_categories(db)]
    return success_response(data=items)


@router.post("")
def create_category(
    payload: CategoryCreate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_admin),
):
    try:
        cat = services.create_category(db, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=CategoryRead.model_validate(cat))


@router.patch("/{slug}")
def update_category(
    slug: str,
    payload: CategoryUpdate,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_admin),
):
    cat = services.get_category(db, slug)
    if not cat:
        return not_found_response(f"카테고리를 찾을 수 없습니다: {slug}")
    cat = services.update_category(db, cat, payload)
    return success_response(data=CategoryRead.model_validate(cat))


@router.delete("/{slug}")
def delete_category(
    slug: str,
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(require_admin),
):
    cat = services.get_category(db, slug)
    if not cat:
        return not_found_response(f"카테고리를 찾을 수 없습니다: {slug}")
    orphan_count = services.delete_category(db, cat)
    msg = (
        f"카테고리 '{slug}'을 삭제했습니다. {orphan_count}개 템플릿이 이 카테고리를 참조 중이었습니다."
        if orphan_count
        else f"카테고리 '{slug}'을 삭제했습니다."
    )
    return success_response(data={"orphan_template_count": orphan_count}, message=msg)
