"""Generic notification table — single backbone for every in-app alert.

Every alert type in the system (코멘트, 멘션, 게시, 종합 인용, 락,
보직장 수정, 등) lives in this one table. Adding a new type means
appending to `NotificationType` + wiring a trigger in the producing
module's service layer — never a new table. This is the single biggest
source of "6개월 뒤 알림 종류마다 새 테이블 만드는 함정" prevention.

`payload` JSONB holds per-type fields (e.g. comment thread id, mention
context, mount target workspace). Readers do `payload["thread_id"]` etc.;
no schema enforcement here on purpose — the type→payload contract lives
in the producer/consumer code, not at the DB layer.

Phase 0 only defines the schema; per-type triggers wire up in Phases
1/2/3 alongside the features that produce them. The inbox UI (좌측 종
+ dropdown) lands in Phase 2 alongside the first usable trigger
(comments).

Email digesting (10-minute batched email per-recipient) lands later;
this table is in-app only at first, and the email path is decoupled
behind a separate worker reading from the same rows.
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
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class NotificationType(str, enum.Enum):
    """Catalog of all notification kinds. Add new values here; don't make
    new tables.

    Naming convention: `<domain>.<event>` so the frontend can route by
    prefix (all `comment.*` open the side panel, all `composite.*` jump
    to the composite, etc.). Each value has an expected payload shape
    documented next to its trigger callsite.
    """

    # Comments
    comment_new = "comment.new"             # 새 코멘트
    comment_reply = "comment.reply"          # thread 답글
    comment_mention = "comment.mention"      # `@user` 멘션 (Phase 7D)
    comment_resolved = "comment.resolved"    # thread resolve

    # Mount / org board
    mount_new_to_me = "mount.new_to_me"      # 내 보고서가 게시됨
    mount_new_in_board = "mount.new_in_board"  # 게시판에 새 보고서

    # Composite roll-up
    composite_included = "composite.included"          # 내 보고서가 종합에 포함됨
    composite_cited_upward = "composite.cited_upward"  # 상위 종합에 인용
    composite_published = "composite.published"        # 내가 작성한 종합 발행

    # Lock
    report_locked = "report.locked"
    report_lock_force_unset = "report.lock_force_unset"

    # Editor-side
    report_edited_by_other = "report.edited_by_other"
    editor_added = "editor.added"

    # Lifecycle
    report_ongoing_reminder = "report.ongoing_reminder"

    # Phase auto-transitions
    report_phase_to_reviewing = "report.phase_to_reviewing"
    report_phase_to_finalized = "report.phase_to_finalized"

    # Phase D 경보 — 규칙이 새로 발화(신규 대상 진입). payload: {rule_name, fired,
    # firing, probe_key, report_title(=rule_name), excerpt}. ref=(alert_rules, rule_id).
    alert_firing = "alert.firing"


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        # The hot path: list a user's unread notifications, newest first.
        # The partial index on `read_at IS NULL` keeps the unread query
        # fast even as the table grows; non-unread lookups fall back to
        # the wider composite index.
        Index(
            "ix_notifications_recipient_unread",
            "recipient_user_id",
            "created_at",
            postgresql_where="read_at IS NULL",
        ),
        Index("ix_notifications_recipient_created", "recipient_user_id", "created_at"),
        Index("ix_notifications_type", "type"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    recipient_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # Who triggered the alert (nullable for system-generated ones like
    # the Friday ongoing-reminder cron job).
    actor_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    type: Mapped[NotificationType] = mapped_column(
        Enum(NotificationType, name="notification_type_enum"),
        nullable=False,
    )

    # Loose reference to the entity the notification is about. The
    # frontend uses (ref_table, ref_id) to build the jump URL. No FK
    # constraint because ref_table varies — keeping these as
    # plain string/int makes notifications survive the eventual
    # delete of their referent (we just stop rendering them).
    ref_table: Mapped[str | None] = mapped_column(String(64), nullable=True)
    ref_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Workspace context — used by the inbox to render "in [팀1]" labels
    # and by future per-workspace mute settings.
    workspace_slug: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("workspaces.slug", ondelete="SET NULL"),
        nullable=True,
    )

    # Per-type fields. See NotificationType docstrings for the shape
    # each producer should write. Readers should always treat keys as
    # optional (`.get(...)`).
    payload: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default="{}", nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    # NULL = unread; setting it to a timestamp marks it read. We don't
    # delete rows — kept for the "받은 코멘트 inbox" history view.
    read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    recipient: Mapped["User"] = relationship(  # noqa: F821
        "User", foreign_keys=[recipient_user_id], lazy="joined"
    )
    actor: Mapped["User | None"] = relationship(  # noqa: F821
        "User", foreign_keys=[actor_user_id], lazy="joined"
    )
