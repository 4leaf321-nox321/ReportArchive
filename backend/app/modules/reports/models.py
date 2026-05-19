"""Report models — instances of templated documents.

Each report is bound to a specific template version (so it stays renderable
even when the template evolves). `content` is the JSON document conforming
to the template's JSON Schema; only the envelope fields (workspace, status,
report_date, owner) are promoted to columns for easy filtering.

Workspace scoping is enforced at the service / RLS layer via `workspace_slug`.
A leaf workspace owns its reports; queries on a non-leaf workspace pull all
descendants via the workspace tree helper.
"""
from __future__ import annotations

import enum
from datetime import date, datetime

from sqlalchemy import (
    Date,
    DateTime,
    Enum,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.modules.users.models import User


class ReportStatus(str, enum.Enum):
    """Work-state status for the report's underlying task.

    Earlier values (in_review / approved / archived) modelled an approval
    workflow that was never wired up — the labels now describe whether
    the work the report covers is still being written, actively in
    progress, or wrapped up.
    """

    draft = "draft"               # 작성 중 — 보고서 자체가 작성 중
    in_progress = "in_progress"   # 진행 업무 — 다루는 업무가 진행 중
    completed = "completed"       # 완료 업무 — 다루는 업무가 완료됨


class Report(Base):
    __tablename__ = "reports"
    __table_args__ = (
        # Composite FK to (templates.template_id, templates.version) so a
        # report can never reference a non-existent template version.
        ForeignKeyConstraint(
            ["template_id", "template_version"],
            ["templates.template_id", "templates.version"],
            name="fk_reports_template_version",
            ondelete="RESTRICT",
        ),
        Index("ix_reports_workspace", "workspace_slug"),
        Index("ix_reports_template", "template_id", "template_version"),
        Index("ix_reports_status", "status"),
        Index("ix_reports_owner", "owner_user_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    workspace_slug: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("workspaces.slug", ondelete="RESTRICT"),
        nullable=False,
    )
    template_id: Mapped[str] = mapped_column(String(64), nullable=False)
    template_version: Mapped[int] = mapped_column(Integer, nullable=False)

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[ReportStatus] = mapped_column(
        Enum(ReportStatus, name="report_status_enum"),
        default=ReportStatus.draft,
        nullable=False,
    )
    owner_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Tracks who last modified the report (touched on every successful
    # update_report() call). Snapshot only — full history lives in journald
    # if needed; an audit-log table would be overkill at this scale.
    updated_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # Free-form tags — small flat list. Will become a dedicated table once
    # entity extraction lands (개발계획.md §1-4 Phase 1).
    tags: Mapped[list[str]] = mapped_column(ARRAY(String), default=list, nullable=False)

    # The actual report content as JSON, conforming to the bound template's
    # schema. Validated on write in the service layer.
    content: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    # Per-report layout overrides keyed by template block id:
    #   { "<block_id>": { "row": int, "col_span": int, "row_span": int }, ... }
    # When a block id is absent here, the template's layout is used. Reports
    # cannot add/remove blocks via this field — only resize/reposition the
    # ones the template already declared.
    layout_overrides: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Per-report widget-props overrides keyed by template block id:
    #   { "<block_id>": { "text_style": {...}, "depth_styles": {...} }, ... }
    # Only visual-style keys are accepted (see services._sanitize_props_overrides);
    # structural props (items, min_length, etc.) cannot be overridden per report
    # because the content schema is derived from them.
    props_overrides: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Ordered list of pages for multi-page reports. Each entry is shaped:
    #   {template_id, template_version, content, layout_overrides, props_overrides}
    # `pages[0]` is mirrored into the top-level columns above so the FK
    # constraint and list-view fields remain authoritative for the *primary*
    # template. Subsequent pages reference their template only via id+version
    # inside this JSON blob (no DB-level FK).
    pages: Mapped[list[dict]] = mapped_column(JSONB, default=list, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    # Optimistic-concurrency counter. Bumped on every successful
    # update_report() call; PATCH callers must echo back the revision they
    # fetched, otherwise the service raises a revision_mismatch 409. Pairs
    # with the pessimistic ReportEditLock below as a belt-and-suspenders
    # safety net (matters specifically right after a forced takeover, when
    # the prior holder may still try to save before they notice).
    revision: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )

    # Aggregation reference date — used by the dashboard's period filters
    # instead of created_at, so reports that are filled in retroactively
    # can still be bucketed against the period they actually describe.
    # Defaults to today on insert; editable from the report form.
    report_date: Mapped[date] = mapped_column(
        Date, nullable=False, server_default=func.current_date()
    )

    # Eagerly load the two user joins — every read of a Report needs the
    # owner / last-editor display info, so paying one JOIN beats N+1 lookups
    # in the route layer.
    owner: Mapped["User | None"] = relationship(
        "User", foreign_keys=[owner_user_id], lazy="joined"
    )
    updated_by: Mapped["User | None"] = relationship(
        "User", foreign_keys=[updated_by_user_id], lazy="joined"
    )
    # Current edit lock, if any. Eager-loaded so the report GET can include
    # "who's editing" without a second query. The lock row may exist but be
    # expired — the service layer decides what counts as live.
    edit_lock: Mapped["ReportEditLock | None"] = relationship(
        "ReportEditLock",
        back_populates="report",
        uselist=False,
        cascade="all, delete-orphan",
        lazy="joined",
    )


class ReportEditLock(Base):
    """Pessimistic edit lock — at most one row per report (report_id is PK).

    Acquired when a user enters edit mode; refreshed by periodic heartbeats
    while editing; released on save/cancel/page-leave. The TTL (`expires_at`)
    lets abandoned sessions auto-release: any acquire call past that point
    treats the row as orphaned and upserts the new holder.

    Reads of this row should *always* compare `expires_at` against `now` in
    the service layer — never trust mere existence. See
    services.get_active_lock().
    """

    __tablename__ = "report_edit_locks"

    report_id: Mapped[int] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    acquired_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    report: Mapped["Report"] = relationship(
        "Report", back_populates="edit_lock"
    )
    user: Mapped["User"] = relationship("User", lazy="joined")
