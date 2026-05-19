"""Business logic for section taxonomy."""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.modules.section_taxonomy.models import SectionCategory, SectionItem
from app.modules.section_taxonomy.schemas import (
    SectionCategoryCreate,
    SectionCategoryUpdate,
    SectionItemCreate,
    SectionItemUpdate,
)


# ---------------------------------------------------------------------- #
# Categories                                                              #
# ---------------------------------------------------------------------- #
def list_categories(db: Session) -> list[SectionCategory]:
    """Returns every category with its items eagerly loaded, ordered by
    sort_order. The picker UI consumes this single call to avoid N+1
    round-trips per category."""
    return list(
        db.execute(
            select(SectionCategory)
            .options(selectinload(SectionCategory.items))
            .order_by(SectionCategory.sort_order, SectionCategory.slug)
        ).scalars()
    )


def get_category(db: Session, slug: str) -> Optional[SectionCategory]:
    return db.get(SectionCategory, slug)


def create_category(db: Session, payload: SectionCategoryCreate) -> SectionCategory:
    if db.get(SectionCategory, payload.slug):
        raise ValueError(f"분류 슬러그가 이미 존재합니다: {payload.slug}")
    cat = SectionCategory(
        slug=payload.slug,
        name=payload.name,
        color=payload.color,
        sort_order=payload.sort_order,
    )
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return cat


def update_category(
    db: Session, cat: SectionCategory, payload: SectionCategoryUpdate
) -> SectionCategory:
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        if value is not None:
            setattr(cat, key, value)
    db.commit()
    db.refresh(cat)
    return cat


def delete_category(db: Session, cat: SectionCategory) -> None:
    """Cascades to all items in this category (DB-level ON DELETE CASCADE
    + ORM cascade). Existing reports referencing those item codes keep
    them as orphan strings — the editor shows them as "unknown section"
    in the badge slot and the picker stops listing them."""
    db.delete(cat)
    db.commit()


# ---------------------------------------------------------------------- #
# Items                                                                   #
# ---------------------------------------------------------------------- #
def get_item(db: Session, code: str) -> Optional[SectionItem]:
    return db.get(SectionItem, code)


def create_item(db: Session, payload: SectionItemCreate) -> SectionItem:
    if db.get(SectionItem, payload.code):
        raise ValueError(f"항목 코드가 이미 존재합니다: {payload.code}")
    if not db.get(SectionCategory, payload.category_slug):
        raise ValueError(f"분류를 찾을 수 없습니다: {payload.category_slug}")
    item = SectionItem(
        code=payload.code,
        category_slug=payload.category_slug,
        label=payload.label,
        en=payload.en,
        sort_order=payload.sort_order,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def update_item(
    db: Session, item: SectionItem, payload: SectionItemUpdate
) -> SectionItem:
    data = payload.model_dump(exclude_unset=True)
    # Validate category target when moving.
    if "category_slug" in data and data["category_slug"] is not None:
        if not db.get(SectionCategory, data["category_slug"]):
            raise ValueError(f"분류를 찾을 수 없습니다: {data['category_slug']}")
    for key, value in data.items():
        if value is not None:
            setattr(item, key, value)
    db.commit()
    db.refresh(item)
    return item


def delete_item(db: Session, item: SectionItem) -> None:
    db.delete(item)
    db.commit()
