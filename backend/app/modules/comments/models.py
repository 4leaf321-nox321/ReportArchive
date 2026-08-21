"""Comment threads anchored to individual widget blocks.

Each `CommentThread` is anchored to a `(report_id, page_index, block_id)`
triple — same key the BlockEditorCard renders against on the frontend.
When the underlying block is removed from the template/content, threads
go orphaned (still queryable, but no rendering location); the resolution
is to keep them in a "removed block" bucket on the side panel rather
than hard-delete (review history matters).

`author_role_at_creation` snapshots the author's workspace role at the
moment the thread was started so the frontend can render a "보직장 의견"
chip even if the role changes later (§8.2). The snapshot is intentional
— recomputing on render would surface confusing role changes.

Phase 0 lays the schema only; CRUD + UI come in Phase 2. The
`origin_workspace_slug` is what makes cross-mount comment visibility
work — a thread carries its "where I was written" context so the panel
can show provenance when the same report is viewed from multiple boards
(§8.6).
"""
from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ThreadStatus(str, enum.Enum):
    open = "open"
    resolved = "resolved"


class AuthorRoleSnapshot(str, enum.Enum):
    """Snapshot of the comment author's role at thread-creation time.

    Mirrors `users.Role` values but lives in its own enum so future
    workspace-role changes don't retroactively re-label old comments.
    `lead` is rendered with the "보직장 의견" chip + red accent; all
    others render as plain `member` comments.
    """

    admin = "admin"
    lead = "lead"
    member = "member"


class CommentThread(Base):
    __tablename__ = "comment_threads"
    __table_args__ = (
        # The hot lookup: fetch all threads for a report when opening
        # the side panel. The composite index covers the common
        # "(report, status) where status=open" filter as well.
        Index("ix_comment_threads_report", "report_id", "status"),
        Index("ix_comment_threads_block", "report_id", "page_index", "block_id"),
        Index("ix_comment_threads_author", "author_user_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    # Anchor tuple. `block_id` is the template's stable block identifier
    # (also used in layout_overrides / props_overrides keys). `page_index`
    # is the 0-based index into Report.pages — same convention every
    # other report API uses.
    report_id: Mapped[int] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"), nullable=False
    )
    page_index: Mapped[int] = mapped_column(Integer, nullable=False)
    block_id: Mapped[str] = mapped_column(String(64), nullable=False)

    # Which workspace the thread was created from — needed because a
    # report mounted to multiple boards shows the same threads on each,
    # but provenance ("팀1에서 작성") helps reviewers triage. NULL is
    # tolerated for legacy/seed rows; new rows must set it.
    origin_workspace_slug: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("workspaces.slug", ondelete="SET NULL"),
        nullable=True,
    )

    author_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    author_role_at_creation: Mapped[AuthorRoleSnapshot] = mapped_column(
        Enum(AuthorRoleSnapshot, name="comment_author_role_snapshot_enum"),
        nullable=False,
    )

    status: Mapped[ThreadStatus] = mapped_column(
        Enum(ThreadStatus, name="comment_thread_status_enum"),
        default=ThreadStatus.open,
        server_default=ThreadStatus.open.value,
        nullable=False,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    resolved_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    comments: Mapped[list["Comment"]] = relationship(
        "Comment",
        back_populates="thread",
        order_by="Comment.created_at",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class Comment(Base):
    """Single message inside a CommentThread (head post or reply).

    Body is rich-text JSON (tiptap doc) so mention tokens (Phase 7D)
    can be embedded inline without a separate parse step. Plain text
    is still allowed — the frontend stores `{"type": "doc", "content":
    [{"type": "paragraph", "content": [{"type": "text", "text": "..."}]}]}`
    as the canonical shape.
    """

    __tablename__ = "comments"
    __table_args__ = (
        Index("ix_comments_thread", "thread_id", "created_at"),
        Index("ix_comments_author", "author_user_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    thread_id: Mapped[int] = mapped_column(
        ForeignKey("comment_threads.id", ondelete="CASCADE"), nullable=False
    )
    author_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )

    # tiptap doc JSON. See module docstring for shape.
    body: Mapped[dict] = mapped_column(JSONB, nullable=False)

    # 작성 경로 — 'web'(사람이 화면에서) | 'mcp'(AI 가 사용자 권한으로).
    # MCP 는 사용자의 토큰으로 동작하므로 표식이 없으면 AI 답글이 그 사람이
    # 직접 쓴 것처럼 보인다. **서버가 요청 헤더(X-Client)를 보고 채운다** —
    # 클라이언트가 보낸 값은 신뢰하지 않는다. (p90)
    via: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="web"
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    thread: Mapped[CommentThread] = relationship(
        "CommentThread", back_populates="comments"
    )
