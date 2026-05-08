"""Workspace models — department-level data partition.

Workspaces form a tree (본부 > 팀) via the self-referencing `parent_slug`
column. The slug is the public identifier used in URLs and as the FK
target (rather than an opaque numeric id) because it's stable, readable,
and matches the frontend's URL design.

`virtual=True` marks aggregate-only nodes (e.g. _global) that don't own
data themselves. They never appear as `reports.workspace_slug` values.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Workspace(Base):
    __tablename__ = "workspaces"

    slug: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    parent_slug: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("workspaces.slug", ondelete="RESTRICT"), nullable=True
    )
    color: Mapped[str] = mapped_column(String(16), default="#64748b", nullable=False)
    virtual: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(default=0, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    parent: Mapped["Workspace | None"] = relationship(
        "Workspace", remote_side="Workspace.slug", back_populates="children"
    )
    children: Mapped[list["Workspace"]] = relationship(
        "Workspace", back_populates="parent", cascade="save-update"
    )
