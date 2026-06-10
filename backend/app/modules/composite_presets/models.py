"""Composite report preset (종합보고 양식) models.

A composite preset is a *reusable starting form* for a 종합보고: it carries
a snapshot of the 요약(summary widgets) + 그룹 골격(group names/order) +
보기설정(view_mode) + 설명(description) so a new composite can be born with
that scaffolding already in place instead of empty. The 안건(item refs) are
intentionally NOT captured — they differ every 회차.

The whole snapshot lives in one `seed` JSONB blob — presets are only ever
queried by identity/scope, never by inner content. Unlike `ReportPreset`
there's no template_id/version binding: composites aren't bound to a
template schema.

Visibility mirrors report presets / templates: `owner_workspace_slugs`
NULL/empty = 전사(global); otherwise visible to that workspace's tree
(ancestors + descendants). See services._visible_slugs_for.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class CompositePreset(Base):
    __tablename__ = "composite_presets"
    __table_args__ = (
        Index("ix_composite_presets_owner_workspaces", "owner_workspace_slugs"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)

    # Provenance only — which kind of composite this was snapshotted from
    # (recurring/theme). Applying the preset is kind-agnostic; this just
    # lets the list UI label/filter. NULL for legacy rows.
    source_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)

    # NULL / empty array = 전사(global). Otherwise scoped to the owning
    # workspace's tree (same model as report_presets.owner_workspace_slugs).
    owner_workspace_slugs: Mapped[list[str] | None] = mapped_column(
        ARRAY(String(64)), nullable=True
    )

    # Snapshot payload:
    #   { summary_widgets: [...], groups: ["영업팀","개발팀",...],
    #     view_mode: "single"|"two_col"|"list", description: "..." }
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
