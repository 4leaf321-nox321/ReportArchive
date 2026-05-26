"""ReportActivity — per-report event log.

Single generic table holding every notable thing that happens to a
report: edits, comment events, mount changes, phase transitions, lock
toggles, etc. Other modules write to it via `record_activity()` as a
side effect of their own actions (like Notification, but unconditional
and not user-targeted — this is "what happened to the report",
recipient-agnostic).

The timeline UI (`/api/reports/{id}/activities`) queries this table
chronologically — so adding a new event kind only requires:
  1. Append the enum value here.
  2. Call `record_activity(type=…, payload={…})` from the producing
     service.
  3. Render the new type in the frontend's icon/label map.

Storage: 1 row per event. Edit events are intentionally cheap (payload
optional) so a report being saved repeatedly doesn't bloat the table;
if dedup is ever needed, a worker can collapse consecutive edits by
the same actor within N minutes.
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
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ReportActivityType(str, enum.Enum):
    """What happened. Suffix-based grouping so the frontend can pick
    one icon per family (`comment.*`, `phase.*`, `mount.*`)."""

    created = "created"
    edited = "edited"

    comment_added = "comment_added"
    comment_replied = "comment_replied"
    thread_resolved = "thread_resolved"
    thread_reopened = "thread_reopened"

    phase_to_reviewing = "phase_to_reviewing"
    phase_to_finalized = "phase_to_finalized"
    phase_to_drafting = "phase_to_drafting"  # publish 취소

    mounted = "mounted"
    unmounted = "unmounted"
    mount_folder_changed = "mount_folder_changed"

    folder_changed = "folder_changed"  # personal folder placement

    locked = "locked"
    unlocked = "unlocked"
    lock_force_unset = "lock_force_unset"  # by system admin

    editor_added = "editor_added"      # owner grants edit to a user
    editor_removed = "editor_removed"  # owner revokes


class ReportActivity(Base):
    __tablename__ = "report_activities"
    __table_args__ = (
        # Hot path: "activities for this report, newest first".
        Index("ix_report_activities_report_created", "report_id", "created_at"),
        Index("ix_report_activities_actor", "actor_user_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    report_id: Mapped[int] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"), nullable=False
    )
    # Nullable so system-triggered events (cron, future workers) without
    # a human actor still record cleanly.
    actor_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    type: Mapped[ReportActivityType] = mapped_column(
        Enum(ReportActivityType, name="report_activity_type_enum"),
        nullable=False,
    )
    # Per-type extra fields. Examples:
    #   comment_added: {thread_id, comment_id, excerpt: str (first 80 chars)}
    #   mounted: {workspace_slug}
    #   phase_to_finalized: {previous_phase}
    #   folder_changed: {from_folder_id, to_folder_id}
    # Optional; the type alone is usually enough for a timeline row.
    payload: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default="{}", nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
