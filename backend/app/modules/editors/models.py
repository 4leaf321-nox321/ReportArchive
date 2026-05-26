"""Per-report explicit editor grants (`ReportEditor`).

When the report owner wants to give a specific user (typically not the
보직장, since that path is automatic) the right to edit, they add a row
here from the 게시 dialog's "추가 편집자" field. This is the escape
hatch for cross-team collaborators, outside contributors with
workspace membership, and the rare "한 보고서를 두 명이 같이 쓰는"
case that isn't worth flipping the whole mount to `coauthor` policy.

The grant is unconditional once added — `can_edit()` checks this table
right after the owner check and before the lead/coauthor rules. The
author lock (Report.author_lock_enabled) still vetoes everyone but the
owner, so adding an editor doesn't bypass the lock.

Phase 0 lays the schema; the picker UI + grant/revoke API ship in
Phase 3 alongside the full `can_edit()` rollout.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer
from sqlalchemy.orm import Mapped, mapped_column


from app.database import Base


class ReportEditor(Base):
    __tablename__ = "report_editors"
    __table_args__ = (
        Index("ix_report_editors_user", "user_id"),
    )

    report_id: Mapped[int] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )

    # Audit trail — who added this person and when. Helpful for both
    # the "왜 내가 편집권을 받았지?" question and for cleanups when an
    # admin reviews stale grants.
    added_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    added_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
