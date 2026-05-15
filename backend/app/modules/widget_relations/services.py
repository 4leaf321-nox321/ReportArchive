"""Business logic for widget_relations."""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.widget_relations.models import WidgetRelation
from app.modules.widget_relations.schemas import RelationCreate, RelationUpdate


def list_relations(db: Session) -> list[WidgetRelation]:
    return list(
        db.execute(
            select(WidgetRelation).order_by(
                WidgetRelation.sort_order, WidgetRelation.slug
            )
        ).scalars()
    )


def get_relation(db: Session, slug: str) -> Optional[WidgetRelation]:
    return db.get(WidgetRelation, slug)


def create_relation(db: Session, payload: RelationCreate) -> WidgetRelation:
    if db.get(WidgetRelation, payload.slug):
        raise ValueError(f"관계 슬러그가 이미 존재합니다: {payload.slug}")
    rel = WidgetRelation(
        slug=payload.slug,
        name=payload.name,
        description=payload.description,
        hint_keywords=list(payload.hint_keywords or []),
        sort_order=payload.sort_order,
        is_builtin=False,
    )
    db.add(rel)
    db.commit()
    db.refresh(rel)
    return rel


def update_relation(
    db: Session, rel: WidgetRelation, payload: RelationUpdate
) -> WidgetRelation:
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        if value is not None:
            setattr(rel, key, value)
    db.commit()
    db.refresh(rel)
    return rel


def delete_relation(db: Session, rel: WidgetRelation) -> None:
    """Built-in relations cannot be deleted — admins can still rename or
    reorder them. Custom relations delete freely; existing report content
    that references the slug keeps it (treated as 'unknown relation' by
    the editor, which falls back to the default chip)."""
    if rel.is_builtin:
        raise ValueError(f"빌트인 관계는 삭제할 수 없습니다: {rel.slug}")
    db.delete(rel)
    db.commit()
