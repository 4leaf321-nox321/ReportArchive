"""Folder tree — personal + organizational, single table.

Two flavors distinguished by `kind`:

  * `personal` — owned by a single user (`user_id` set, `workspace_slug`
    NULL). Visible only to that user. Used to organize their own
    reports in personal space.
  * `org` — workspace-wide shared (`workspace_slug` set, `user_id` NULL).
    Visible to all members of the workspace. CRUD restricted to
    workspace admin/lead. Used to organize *mounted* reports on the
    org board (placement is stored in `report_mount_folders`, not on
    the Report itself, so the same report can sit in different folders
    on different boards — and in several folders on one board).

The tree is self-referencing via `parent_id` — the convention is that
all nodes in a tree share the same `kind`/scope; the service layer
enforces "you can't reparent a personal folder under an org folder"
when handling moves.

Default folder set ("진행 중", "종결", "보관") is auto-created on first
list call — for personal scope per-user, for org scope per-workspace.
"""
from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class FolderKind(str, enum.Enum):
    personal = "personal"
    org = "org"


class Folder(Base):
    __tablename__ = "folders"
    __table_args__ = (
        # The "exactly one of (user_id, workspace_slug) is set, matching
        # `kind`" rule. Prevents an org folder with a user_id slipping
        # in (which would let a user claim ownership of a shared folder
        # via forged payloads).
        CheckConstraint(
            "(kind = 'personal' AND user_id IS NOT NULL AND workspace_slug IS NULL) OR "
            "(kind = 'org' AND workspace_slug IS NOT NULL AND user_id IS NULL)",
            name="ck_folders_scope_matches_kind",
        ),
        Index("ix_folders_user_parent", "user_id", "parent_id"),
        Index("ix_folders_workspace_parent", "workspace_slug", "parent_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    kind: Mapped[FolderKind] = mapped_column(
        Enum(FolderKind, name="folder_kind_enum"),
        nullable=False,
        server_default=FolderKind.personal.value,
    )

    # Set when kind=personal, NULL when kind=org.
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    # Set when kind=org, NULL when kind=personal.
    workspace_slug: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("workspaces.slug", ondelete="CASCADE"),
        nullable=True,
    )

    # NULL = top-level folder under its scope's root.
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("folders.id", ondelete="CASCADE"), nullable=True
    )

    name: Mapped[str] = mapped_column(String(128), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # 조직 간 공개 폴더별 override (조직간공개_설계.md §4.2). 3-state:
    # NULL=게시판 기본값(workspace.external_view_default) 상속, TRUE=공개,
    # FALSE=비공개. org 폴더에만 의미; personal 폴더는 항상 무시(공개 대상 아님).
    external_view: Mapped[bool | None] = mapped_column(
        Boolean, nullable=True, server_default=None
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    parent: Mapped["Folder | None"] = relationship(
        "Folder", remote_side="Folder.id", back_populates="children"
    )
    # `passive_deletes=True` + `cascade="all, delete-orphan"` so the DB
    # ondelete=CASCADE on parent_id actually fires. Without it, SQLAlchemy
    # auto-NULLs children's parent_id before issuing the parent DELETE,
    # which silently promotes them up one level instead of cascading the
    # deletion. The DB constraint becomes a no-op because the rows are
    # already disowned. See SQLAlchemy "Notes on Delete - Deleting
    # Objects Referenced from Collections and Scalar Relationships".
    children: Mapped[list["Folder"]] = relationship(
        "Folder",
        back_populates="parent",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
