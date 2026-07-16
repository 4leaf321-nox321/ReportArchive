"""Notice board — system-wide announcements posted by system admins.

Read by everyone, written only by system admins. This is the mirror of
VOC: VOC carries feedback *from* users *to* the operators, notices go the
other way — operators announcing to everyone. Kept deliberately simple
(간결형): title / body / image attachments + a `pinned` flag so important
notices float to the top. No categories / status / priority (those are
feedback-triage concepts, meaningless for an announcement) and no
comments (read-only board).

Like VOC, notices aren't tied to a workspace's data model — the sidebar /
header link to /notices with no workspace prefix — so there's no
workspace_slug scoping here.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
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


class NoticePost(Base):
    __tablename__ = "notice_posts"
    __table_args__ = (
        Index("ix_notice_posts_pinned", "pinned"),
        Index("ix_notice_posts_author", "author_user_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # 상단 고정 — 중요 공지를 목록 맨 위로 띄운다. 정렬은 pinned desc,
    # created_at desc.
    pinned: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, server_default=text("false")
    )
    author_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # 첨부 이미지/스크린샷. 각 항목은 {file_id, filename, size, mime_type}
    attachments: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    author: Mapped["User | None"] = relationship(
        "User", foreign_keys=[author_user_id], lazy="joined"
    )
