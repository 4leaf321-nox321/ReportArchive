"""Widget relation — controlled vocabulary for hierarchical item relations
inside the rich_text widget (e.g. 원인/결과/예시).

Stored as plain strings inside `reports.content[block_id].items[*].relation`,
so this table is purely a display vocabulary — like template_categories,
deletions leave existing references intact (they just stop appearing in
admin/picker UIs). Built-in rows ship with the initial migration; admins
can add custom ones or hide built-ins via sort_order.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class WidgetRelation(Base):
    __tablename__ = "widget_relations"

    slug: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    description: Mapped[str | None] = mapped_column(String(256), nullable=True)
    # Phrases that, when typed at the start of an outline item, the editor
    # can surface as a "did you mean [relation]?" hint. Plain strings, ko/en
    # both allowed.
    hint_keywords: Mapped[list[str]] = mapped_column(
        JSONB, default=list, nullable=False
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Built-ins ship with the migration and cannot be deleted by admins
    # (they can still be renamed / reordered / have hints edited).
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )
