"""Workspace models — department-level data partition + personal spaces.

Workspaces form a tree (본부 > 팀) via the self-referencing `parent_slug`
column. The slug is the public identifier used in URLs and as the FK
target (rather than an opaque numeric id) because it's stable, readable,
and matches the frontend's URL design.

`kind` distinguishes three workspace flavors:
  - `org`      — the organizational tree (default). Team/division boards
                 where mounted reports become visible to members.
  - `personal` — single-user scratch space, auto-created on user signup.
                 Reports are born here; promotion to an org workspace is
                 explicit via the mount mechanism.
  - `virtual`  — aggregate-only nodes (e.g. _global) that don't own data
                 themselves. They never appear as `reports.workspace_slug`
                 values.

For `kind=personal`, `personal_owner_user_id` is the owning user; for
the other kinds it stays NULL. The slug convention is
`personal-{user_id}` (set by the user-signup hook / Phase 0 migration).
"""
from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class WorkspaceKind(str, enum.Enum):
    org = "org"
    personal = "personal"
    virtual = "virtual"


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
    # Kind orthogonal to `virtual` (which is being phased out — for new
    # rows prefer `kind=virtual`). Existing aggregate nodes get
    # `kind=virtual` in the Phase 0 migration; `virtual=True` is kept for
    # backward-compat reads but new code should branch on `kind`.
    kind: Mapped[WorkspaceKind] = mapped_column(
        Enum(WorkspaceKind, name="workspace_kind_enum"),
        nullable=False,
        default=WorkspaceKind.org,
        server_default=WorkspaceKind.org.value,
    )
    # Only set when kind=personal. Unique so each user has at most one
    # personal workspace. NULL for org/virtual.
    personal_owner_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
        unique=True,
        index=True,
    )
    sort_order: Mapped[int] = mapped_column(default=0, nullable=False)

    # 조직 간 공개(조직간공개_설계.md §4.1). 이 게시판에 게시된 보고서를
    # 다른 조직이 조회 가능한가 — 폴더가 override 가능(Folder.external_view).
    # org 게시판에만 의미; personal/virtual 은 무시(개인공간은 공개 대상 아님).
    external_view_default: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    parent: Mapped["Workspace | None"] = relationship(
        "Workspace", remote_side="Workspace.slug", back_populates="children"
    )
    children: Mapped[list["Workspace"]] = relationship(
        "Workspace", back_populates="parent", cascade="save-update"
    )
