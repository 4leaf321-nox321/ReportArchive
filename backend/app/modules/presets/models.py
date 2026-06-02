"""Report preset (시작 양식) models.

A preset is a *filled-in* starting point for a report: it binds to a
specific template version (like a report does) and carries a content
snapshot so a new report can be born pre-populated instead of blank.

The whole seed (pages + tags + report_type + entity ids + display
settings) lives in one `seed` JSONB blob — presets are only ever queried
by identity/binding/scope, never by their inner content, so there's no
value in promoting those to columns. The seed shape mirrors what
`reports.services.copy_report` snapshots.

Visibility mirrors templates: `owner_workspace_slugs` NULL/empty = 전사
(global); otherwise visible to that workspace's tree (ancestors +
descendants). See presets.services._visible_slugs_for.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ReportPreset(Base):
    __tablename__ = "report_presets"
    __table_args__ = (
        # Bind to an immutable template version, exactly like reports — a
        # preset stays renderable even when the template evolves.
        ForeignKeyConstraint(
            ["template_id", "template_version"],
            ["templates.template_id", "templates.version"],
            name="fk_report_presets_template",
            ondelete="RESTRICT",
        ),
        Index("ix_report_presets_template", "template_id"),
        Index("ix_report_presets_owner_workspaces", "owner_workspace_slugs"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)

    template_id: Mapped[str] = mapped_column(String(64), nullable=False)
    template_version: Mapped[int] = mapped_column(Integer, nullable=False)

    # NULL / empty array = 전사(global). Otherwise scoped to the owning
    # workspace's tree (same model as templates.owner_workspace_slugs).
    owner_workspace_slugs: Mapped[list[str] | None] = mapped_column(
        ARRAY(String(64)), nullable=True
    )

    # Full seed payload mirroring a ReportCreate body:
    #   { pages, tags, report_type_id, entity_ids, page_width_px,
    #     page_gap_px, page_blend_blocks, page_slide_*, page_rich_text_prefix_* }
    seed: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)

    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    created_by: Mapped["User | None"] = relationship(  # noqa: F821
        "User", foreign_keys=[created_by_user_id], lazy="joined"
    )
