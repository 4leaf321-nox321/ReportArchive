"""VOC (Voice of Customer) board — a system-wide discussion board for
tool feedback (bugs / feature requests / questions / improvement ideas).

Distinct from reports/composites: posts here aren't tied to a workspace's
data model — they're a forum for the *operators of the system itself*.
Any authenticated user can post and comment; admins triage status /
priority. We keep `workspace_slug` and `linked_url` on posts purely as
context hints for admins (where was the user when they hit this issue?)
— not for visibility scoping.
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
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.modules.users.models import User


class VocCategory(str, enum.Enum):
    bug = "bug"
    feature = "feature"
    question = "question"
    improvement = "improvement"
    other = "other"


class VocStatus(str, enum.Enum):
    open = "open"
    in_progress = "in_progress"
    resolved = "resolved"
    wontfix = "wontfix"


class VocPriority(str, enum.Enum):
    low = "low"
    normal = "normal"
    high = "high"
    critical = "critical"


class VocPost(Base):
    __tablename__ = "voc_posts"
    __table_args__ = (
        Index("ix_voc_posts_status", "status"),
        Index("ix_voc_posts_category", "category"),
        Index("ix_voc_posts_author", "author_user_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str] = mapped_column(Text, default="", nullable=False)
    category: Mapped[VocCategory] = mapped_column(
        Enum(VocCategory, name="voc_category_enum"),
        default=VocCategory.question,
        nullable=False,
    )
    status: Mapped[VocStatus] = mapped_column(
        Enum(VocStatus, name="voc_status_enum"),
        default=VocStatus.open,
        nullable=False,
    )
    priority: Mapped[VocPriority] = mapped_column(
        Enum(VocPriority, name="voc_priority_enum"),
        default=VocPriority.normal,
        nullable=False,
    )
    author_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Which workspace was the user in when posting? Optional triage
    # hint — VOC visibility itself is system-wide, not workspace-scoped.
    workspace_slug: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("workspaces.slug", ondelete="SET NULL"),
        nullable=True,
    )
    # Screenshots / images attached to the post. Each entry is
    # `{file_id, filename, size, mime_type}` — same shape image and
    # attachment widgets use, so files share the /api/files lifecycle.
    # Replaces the older `linked_url` free-text field — users don't
    # have to copy/paste a page URL anymore.
    attachments: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    author: Mapped["User | None"] = relationship(
        "User", foreign_keys=[author_user_id], lazy="joined"
    )
    comments: Mapped[list["VocComment"]] = relationship(
        "VocComment",
        back_populates="post",
        cascade="all, delete-orphan",
        order_by="VocComment.id",
        lazy="selectin",
    )


class VocComment(Base):
    __tablename__ = "voc_comments"
    __table_args__ = (
        Index("ix_voc_comments_post", "post_id"),
        Index("ix_voc_comments_author", "author_user_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    post_id: Mapped[int] = mapped_column(
        ForeignKey("voc_posts.id", ondelete="CASCADE"), nullable=False
    )
    author_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    post: Mapped[VocPost] = relationship(
        "VocPost", back_populates="comments"
    )
    author: Mapped["User | None"] = relationship(
        "User", foreign_keys=[author_user_id], lazy="joined"
    )
