"""Template models.

Templates are immutable per (template_id, version). Editing a template
publishes a new version; old versions remain so reports created against
them stay renderable.

Visibility model (hybrid sharing, multi-workspace):
  - owner_workspace_slugs = NULL or empty → global / 전사 (visible to all)
  - owner_workspace_slugs = ['dev']       → scoped to dev's tree
                                            (dev + descendants + ancestors)
  - owner_workspace_slugs = ['dev','biz'] → visible to either tree

The visibility filter is applied in the service layer using workspace
tree helpers — a template is visible if ANY of its owner slugs
intersects the actor's accessible tree.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    PrimaryKeyConstraint,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Template(Base):
    """Versioned template — composite PK (template_id, version)."""

    __tablename__ = "templates"
    __table_args__ = (
        PrimaryKeyConstraint("template_id", "version", name="pk_templates"),
        Index("ix_templates_owner_workspaces", "owner_workspace_slugs"),
        Index("ix_templates_template_id", "template_id"),
    )

    template_id: Mapped[str] = mapped_column(String(64), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    category: Mapped[str] = mapped_column(String(64), default="misc", nullable=False)

    # JSON Schema 2020-12 stored verbatim. Validated on insert (the document is
    # itself a JSON Schema, so we sanity-check it before saving).
    schema: Mapped[dict] = mapped_column(JSONB, nullable=False)

    # NULL or empty array = global / 전사.
    # Each slug refers to a row in `workspaces`. We don't FK to that table
    # at the array level (Postgres doesn't support per-element FK), so the
    # service layer is responsible for validating membership before insert.
    owner_workspace_slugs: Mapped[list[str] | None] = mapped_column(
        ARRAY(String(64)), nullable=True
    )

    is_published: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_latest: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # 보관(아카이브). set 되면 작성 picker·기본 목록에서 숨고 새 보고서 작성이
    # 막힌다. 단 by-id 렌더는 그대로라 기존 보고서는 계속 렌더된다(삭제와 달리
    # 행이 살아있음). template_id 단위 개념 — 보관 시 모든 버전 행에 set 한다.
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True, index=True
    )
    archived_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
