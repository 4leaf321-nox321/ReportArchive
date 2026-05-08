"""Business logic for template categories."""
from __future__ import annotations

from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.template_categories.models import TemplateCategory
from app.modules.template_categories.schemas import CategoryCreate, CategoryUpdate
from app.modules.templates.models import Template


def list_categories(db: Session) -> list[TemplateCategory]:
    return list(
        db.execute(
            select(TemplateCategory).order_by(
                TemplateCategory.sort_order, TemplateCategory.slug
            )
        ).scalars()
    )


def get_category(db: Session, slug: str) -> Optional[TemplateCategory]:
    return db.get(TemplateCategory, slug)


def create_category(db: Session, payload: CategoryCreate) -> TemplateCategory:
    if db.get(TemplateCategory, payload.slug):
        raise ValueError(f"카테고리 슬러그가 이미 존재합니다: {payload.slug}")
    cat = TemplateCategory(
        slug=payload.slug, name=payload.name, sort_order=payload.sort_order
    )
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return cat


def update_category(
    db: Session, cat: TemplateCategory, payload: CategoryUpdate
) -> TemplateCategory:
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        if value is not None:
            setattr(cat, key, value)
    db.commit()
    db.refresh(cat)
    return cat


def delete_category(db: Session, cat: TemplateCategory) -> int:
    """Delete the category. Returns the count of templates that were
    referencing it (now orphaned — they keep the category string but it
    won't appear in pickers until a category with that slug is recreated).
    """
    orphan_count = (
        db.execute(
            select(func.count(Template.template_id)).where(Template.category == cat.slug)
        ).scalar()
        or 0
    )
    db.delete(cat)
    db.commit()
    return int(orphan_count)
