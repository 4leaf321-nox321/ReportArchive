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
    Boolean,
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


class ReportPhase(str, enum.Enum):
    """Report's collaboration lifecycle — label, not gate.

    Designed to avoid the "approval workflow that nobody uses" trap:
    phase changes happen as side-effects of natural actions (mounting to
    an org board, getting a first external comment, hitting "publish"),
    never via an explicit "request review" gesture. See 협업개선_설계.md
    §8.3 for the auto-transition rules and UI behavior matrix.
    """

    drafting = "drafting"     # 작성 중 — 편집 위주, 핀 hover로만
    reviewing = "reviewing"   # 리뷰 중 — 피드백 수렴, 핀 항상 표시
    finalized = "finalized"   # 발행 완료 — 편집 차단, 코멘트 read-only


class ReportLifecycle(str, enum.Enum):
    """Whether the work the report covers is one-shot or ongoing.

    Orthogonal to `phase` (which is about collaboration state). Used by
    the composite recurring-rollup logic (§7) to decide auto-carry-over
    candidates. `single_shot` only appears in the week it was first
    published; `ongoing` is automatically offered as a carry-over
    candidate every subsequent recurring composite until `closed_at` is
    set.
    """

    single_shot = "single_shot"
    ongoing = "ongoing"


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
        Index("ix_reports_phase", "phase"),
        Index("ix_reports_owner", "owner_user_id"),
        Index("ix_reports_folder", "folder_id"),
        # Carried over from earlier migrations (e18e0d43a9a6, 4b5fea6acfdd)
        # so autogen doesn't try to drop them. The dashboard filters on
        # report_date; updated_by_user_id powers the "최근 편집자" list.
        Index("ix_reports_report_date", "report_date"),
        Index("ix_reports_updated_by_user_id", "updated_by_user_id"),
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
    # Collaboration lifecycle — see ReportPhase docstring.
    # Auto-transitions: first external comment OR mount-to-org-board
    # bumps drafting → reviewing. Explicit "publish" / "unpublish"
    # buttons toggle finalized. No "request review" gate.
    phase: Mapped[ReportPhase] = mapped_column(
        Enum(ReportPhase, name="report_phase_enum"),
        default=ReportPhase.drafting,
        server_default=ReportPhase.drafting.value,
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

    # Phase 3 — denormalized "last editor" for listing UIs ("박과장 작성
    # · 김부장 수정"). Updated whenever someone other than the owner
    # saves, OR also bumped on owner edits so listings always have the
    # most recent. updated_by_user_id stays for backward compat (some
    # legacy views reference it).
    last_edited_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    last_edited_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
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

    # Per-report max content width in pixels. NULL = use the frontend's
    # narrow default (~1024px). Editable from the report detail view via
    # the empty-area right-click "보고서 폭 설정". Capped client-side at
    # 3000; the server only enforces the integer column type.
    page_width_px: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Per-report vertical gap (px) between top-level widget rows. NULL =
    # use the frontend default. Editable from the 보고서 설정 dialog's
    # 페이지 설정 tab. Capped client-side at 0–200; the server only
    # enforces the integer column type.
    page_gap_px: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # When True, widget container chrome (the per-block card border /
    # background / shadow) blends into the page so individual widgets
    # are no longer visually delimited. NULL/False keeps the default
    # bordered cards. Editable from the 보고서 설정 dialog's page tab.
    page_blend_blocks: Mapped[bool | None] = mapped_column(
        Boolean, nullable=True
    )

    # PPT export 보조용 슬라이드 가이드. 본문 위에 슬라이드 한 장이
    # 차지할 세로 경계를 점선으로 보여준다. 4개 컬럼 모두 NULL이면
    # 프론트는 "가이드 OFF"로 취급한다. page_slide_ratio 는 "16:9" /
    # "4:3" / "16:10" / "custom" 중 하나이고, "custom" 일 때만 _custom_w
    # / _custom_h 가 의미를 가진다.
    page_slide_guide: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    page_slide_ratio: Mapped[str | None] = mapped_column(String(16), nullable=True)
    page_slide_ratio_custom_w: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    page_slide_ratio_custom_h: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )

    # Optional report-type tag — system-wide controlled vocabulary
    # orthogonal to the template (templates describe shape; types
    # describe purpose, e.g. "주간 보고", "안전 점검"). Managed by
    # the report_types module; SET NULL on delete so reports never
    # cascade-vanish when an admin cleans up the vocabulary.
    report_type_id: Mapped[int | None] = mapped_column(
        ForeignKey("report_types.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # ── Personal-space organization ─────────────────────────────────────
    # Personal-space folder this report sits in. NULL = uncategorized
    # ("분류 안 한 보고서"). Folders are per-user (folders module owns
    # them). Mount status / org visibility is orthogonal — folder is a
    # purely personal organizational concern.
    folder_id: Mapped[int | None] = mapped_column(
        ForeignKey("folders.id", ondelete="SET NULL"), nullable=True
    )

    # ── Lifecycle (single vs ongoing) ───────────────────────────────────
    # See ReportLifecycle docstring. `ongoing` reports are auto-offered
    # as carry-over candidates in the next recurring composite; `closed_at`
    # turns that off (the work wrapped up).
    lifecycle: Mapped[ReportLifecycle] = mapped_column(
        Enum(ReportLifecycle, name="report_lifecycle_enum"),
        default=ReportLifecycle.single_shot,
        server_default=ReportLifecycle.single_shot.value,
        nullable=False,
    )
    closed_at: Mapped[date | None] = mapped_column(Date, nullable=True)

    # ── Author hard lock (max-priority edit veto) ───────────────────────
    # When `author_lock_enabled` is True, only the owner can edit — every
    # other path (lead role, additional editors, coauthor policy) is
    # blocked. Reason is shown in the lock banner. Workspace admin can
    # force-unset (audit-logged) when the owner is unavailable.
    author_lock_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    author_lock_reason: Mapped[str] = mapped_column(Text, default="", nullable=False)
    author_lock_set_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )

    # ── Fork lineage (referenced copy from another team's report) ──────
    # Set when this report was created via "참조 복제" from another
    # report (Phase 8 feature; columns laid down now to avoid a later
    # migration). `forked_from_report_id` is SET NULL on origin delete so
    # the copy survives; `forked_at_revision` records the origin's
    # revision number at the moment of copy for "compare to current"
    # back-references.
    forked_from_report_id: Mapped[int | None] = mapped_column(
        ForeignKey("reports.id", ondelete="SET NULL"), nullable=True
    )
    forked_at_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Eagerly load the two user joins — every read of a Report needs the
    # owner / last-editor display info, so paying one JOIN beats N+1 lookups
    # in the route layer.
    owner: Mapped["User | None"] = relationship(
        "User", foreign_keys=[owner_user_id], lazy="joined"
    )
    updated_by: Mapped["User | None"] = relationship(
        "User", foreign_keys=[updated_by_user_id], lazy="joined"
    )
    # Phase 3 — Same JOIN cost as updated_by; tiny User row, eagerly
    # loaded so listings can render "박과장 · 김부장 수정" without N+1.
    last_editor: Mapped["User | None"] = relationship(
        "User", foreign_keys=[last_edited_by_user_id], lazy="joined"
    )

    # Eager-load the report-type tag — list payloads need name + status
    # for the "종류" column, and detail views show the description in
    # the settings dialog. Skipping the JOIN would mean an N+1 over the
    # list endpoint.
    report_type: Mapped["ReportType | None"] = relationship(  # noqa: F821
        "ReportType",
        foreign_keys=[report_type_id],
        lazy="joined",
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

    # M:N to Entity via the `report_entities` link table (owned by the
    # `entities` module). `selectin` avoids the row-multiplication a
    # joined load would cause across the M:N — one extra SELECT per
    # batch is the right trade-off for list endpoints that pull dozens
    # of reports at once. `order_by` keeps the JSON shape deterministic.
    entities: Mapped[list["Entity"]] = relationship(  # noqa: F821
        "Entity",
        secondary="report_entities",
        lazy="selectin",
        order_by="Entity.value",
    )

    # Org-board placements (게시). `selectin` so a list endpoint pulling
    # 50 reports does one extra SELECT IN for all their mounts rather
    # than 50 lazy lookups. `viewonly` because the actual mount/unmount
    # lifecycle is owned by the mounts service — this side is read-only
    # projection. ReportMount.workspace is `joined`, so the mount rows
    # arrive with the Workspace name already attached for the list cell
    # ("팀1·본부A에 게시됨").
    mounts: Mapped[list["ReportMount"]] = relationship(  # noqa: F821
        "ReportMount",
        primaryjoin="Report.id == ReportMount.report_id",
        foreign_keys="ReportMount.report_id",
        lazy="selectin",
        order_by="ReportMount.mounted_at",
        viewonly=True,
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
