"""Report types — controlled vocabulary for categorizing reports
*orthogonal* to templates.

A template defines the *shape* of a report (what blocks it has). A
report type tags the *purpose* (예: "주간 보고", "안전 점검", "고객
인터뷰") and is selectable independently. The list is system-wide so a
report from one workspace can share the same "주간 보고" type as another.

Any authenticated user can propose a new type while editing a report —
those land here as `status=unofficial`. Admins (anyone holding admin
role in *any* workspace, same as VOC) review them in the admin page
and either promote to `official` (visible to everyone in the picker) or
delete. Until promoted, an unofficial type is only visible to its
creator's picker + admins' admin tab — that keeps the global list from
filling up with typos and one-off labels.
"""
from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.modules.users.models import User


class ReportTypeStatus(str, enum.Enum):
    official = "official"
    unofficial = "unofficial"


class ReportType(Base):
    __tablename__ = "report_types"
    __table_args__ = (
        Index("ix_report_types_status", "status"),
        Index("ix_report_types_created_by", "created_by_user_id"),
        # Case-insensitive uniqueness is enforced at the service layer
        # via lower(name) lookups; a plain unique on name catches the
        # exact-match collisions and the lower() check picks up the rest.
        Index("uq_report_types_name", "name", unique=True),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[ReportTypeStatus] = mapped_column(
        Enum(ReportTypeStatus, name="report_type_status_enum"),
        default=ReportTypeStatus.unofficial,
        nullable=False,
    )

    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    approved_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_by: Mapped["User | None"] = relationship(
        "User", foreign_keys=[created_by_user_id], lazy="joined"
    )
    approved_by: Mapped["User | None"] = relationship(
        "User", foreign_keys=[approved_by_user_id], lazy="joined"
    )
