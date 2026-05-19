"""Section taxonomy — admin-managed vocabulary for the "단락 구분" tag
attached to widgets in a report page.

Two-level shape mirrors the picker UI: a small set of broad **categories**
(배경 및 정의, 분석 및 검토, …) each containing a flat list of **items**
(rationale, risk, action_item, …). Item codes are written into
`reports.pages[*].block_sections[block_id]` as opaque strings, so deletes
leave existing reports intact — the picker just stops listing the code in
its catalog. Codes are immutable after creation for the same reason.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class SectionCategory(Base):
    __tablename__ = "section_categories"

    slug: Mapped[str] = mapped_column(String(48), primary_key=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    # Hex color used by the picker's category circle + the per-widget
    # badge in the report editor. Stored as #RRGGBB to keep parsing
    # simple on the frontend.
    color: Mapped[str] = mapped_column(String(9), nullable=False, default="#64748b")
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    items: Mapped[list["SectionItem"]] = relationship(
        "SectionItem",
        back_populates="category",
        cascade="all, delete-orphan",
        order_by="SectionItem.sort_order, SectionItem.code",
    )


class SectionItem(Base):
    __tablename__ = "section_items"

    # The opaque code stored on report blocks. Once a category is fixed,
    # `code` is unique across the whole table — even though items have a
    # parent category, the picker resolves item → category via this row's
    # FK, so picker output is just the single code.
    code: Mapped[str] = mapped_column(String(48), primary_key=True)
    category_slug: Mapped[str] = mapped_column(
        String(48),
        ForeignKey("section_categories.slug", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    label: Mapped[str] = mapped_column(String(64), nullable=False)
    # Optional English label — surfaced as a tooltip in the picker, kept
    # so the seed taxonomy round-trips intact.
    en: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    category: Mapped["SectionCategory"] = relationship(
        "SectionCategory", back_populates="items"
    )
