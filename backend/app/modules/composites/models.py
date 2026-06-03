"""Composite report models — 종합보고.

A composite report bundles N source reports (or other composites) into a
single rollup. Two flavors:

  - recurring  (정기): tied to a period_date — a week's worth of team
    digests, a month's snapshot, etc. The frontend filters the picker by
    that date.
  - theme      (주제): time-independent. Aggregates around a topic like
    "Q2 incidents" or "신규 고객 대응".

Composites can reference other composites as items (not just leaf
reports), so higher-tier digests can roll up team-tier digests further.
The polymorphic item shape is enforced with a CHECK constraint at the
DB layer (exactly one of ref_report_id / ref_composite_id is set).
"""
from __future__ import annotations

import enum
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.modules.users.models import User


class CompositeKind(str, enum.Enum):
    recurring = "recurring"   # 정기
    theme = "theme"           # 주제


class CompositeReport(Base):
    __tablename__ = "composite_reports"
    __table_args__ = (
        Index("ix_composite_reports_workspace", "workspace_slug"),
        Index("ix_composite_reports_kind", "kind"),
        Index("ix_composite_reports_period_date", "period_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    workspace_slug: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("workspaces.slug", ondelete="RESTRICT"),
        nullable=False,
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[CompositeKind] = mapped_column(
        Enum(CompositeKind, name="composite_kind_enum"),
        nullable=False,
    )
    # Anchored period for recurring composites; NULL for theme.
    period_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)

    # 화면 보기 모드(레거시 boolean). view_mode 도입 후로는 view_mode 가
    # 진실의 원천이고 이 컬럼은 하위호환용으로만 남겨 둔다(읽지 않음).
    two_col_view: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )

    # 화면 보기 모드: 'single'(단일) | 'two_col'(2단) | 'list'(리스트와 함께
    # 보기 — 좌측 안건 목록 + 우측 상세). 항목별 `display_column`(DOCX 2단
    # 출력용)과는 별개인 순수 화면 상태라 새로고침해도 유지되게 저장한다.
    view_mode: Mapped[str] = mapped_column(
        String(16), default="single", server_default="single", nullable=False
    )

    # 요약 페이지 — "설명"과 "포함된 안건" 사이에 위젯으로 작성하는 자유 콘텐츠.
    # 템플릿 바인딩 없이 위젯이 자기완결(free-form). 각 항목 모양:
    #   { id, type, props, content, layout: {x, y, w, h} }
    # 보고서와 동일한 12열 그리드 좌표계(react-grid-layout). 비어 있으면 [].
    summary_widgets: Mapped[list[dict]] = mapped_column(
        JSONB, default=list, server_default="[]", nullable=False
    )

    # Optional series identifier — groups successive recurring composites
    # of the same (workspace, owner, kind) into a chain so the frontend
    # can offer "이전 회차 복제" + auto-carry-over of ongoing items
    # (§7.2 / Phase 6). NULL = not part of an explicit series; chain is
    # then inferred at query time by (workspace_slug, owner_user_id,
    # kind=recurring, period_date - 7d). Explicit series_id wins when set
    # because the inference rule breaks down for off-cadence reports.
    series_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)

    owner_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # Publish state (Phase 5A). NULL = draft (recurring) OR not applicable
    # (theme — theme composites stay live forever and never publish).
    # When set, all `recurring` items get their content frozen into
    # `CompositeReportItem.snapshot_content` — readers prefer that over
    # live ref_report content. Unpublish clears these and the per-item
    # snapshots simultaneously.
    published_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True, index=True
    )
    published_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    owner: Mapped["User | None"] = relationship(
        "User", foreign_keys=[owner_user_id], lazy="joined"
    )
    updated_by: Mapped["User | None"] = relationship(
        "User", foreign_keys=[updated_by_user_id], lazy="joined"
    )
    published_by: Mapped["User | None"] = relationship(
        "User", foreign_keys=[published_by_user_id], lazy="joined"
    )
    items: Mapped[list["CompositeReportItem"]] = relationship(
        "CompositeReportItem",
        # CompositeReportItem has TWO FKs back to composite_reports
        # (composite_id for membership, ref_composite_id for sub-refs);
        # disambiguate to the membership side.
        back_populates="composite",
        foreign_keys="CompositeReportItem.composite_id",
        order_by="CompositeReportItem.position, CompositeReportItem.id",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class CompositeReportItem(Base):
    __tablename__ = "composite_report_items"
    __table_args__ = (
        CheckConstraint(
            "(ref_report_id IS NOT NULL)::int + (ref_composite_id IS NOT NULL)::int = 1",
            name="ck_composite_item_exactly_one_ref",
        ),
        Index("ix_composite_items_composite", "composite_id"),
        Index("ix_composite_items_report", "ref_report_id"),
        Index("ix_composite_items_subcomposite", "ref_composite_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    composite_id: Mapped[int] = mapped_column(
        ForeignKey("composite_reports.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    note: Mapped[str] = mapped_column(Text, default="", nullable=False)

    ref_report_id: Mapped[int | None] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"), nullable=True
    )
    ref_composite_id: Mapped[int | None] = mapped_column(
        ForeignKey("composite_reports.id", ondelete="CASCADE"), nullable=True
    )

    # Snapshot of the referenced report's content at the moment a recurring
    # composite was published — fills on transition of the parent composite
    # to its `finalized` state (§7.1). NULL means "use live" (the default
    # for `theme` composites, which stay live forever, and for unpublished
    # `recurring` composites being actively edited). Readers prefer
    # `snapshot_content` when present.
    snapshot_content: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    snapshot_taken_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )

    # Per-item placement for the DOCX export's landscape-2col layout
    # (Phase 5B). `1` = left column (default), `2` = right column. The
    # portrait/1-col export ignores this entirely — column flow is
    # only used when the user picks the two-column landscape option.
    display_column: Mapped[int] = mapped_column(
        Integer, default=1, server_default="1", nullable=False
    )

    # Optional group name — items sharing the same value are visually
    # grouped on screen and Word export emits a "[group_name]" header
    # paragraph before the first item of each group. NULL / "" = no
    # group (ungrouped flow). Plain free text, no separate `groups`
    # master table — the set of groups is just the distinct non-empty
    # values across this composite's items.
    group_name: Mapped[str | None] = mapped_column(
        String(128), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    composite: Mapped[CompositeReport] = relationship(
        "CompositeReport",
        back_populates="items",
        foreign_keys=[composite_id],
    )
    # Eager-load the leaf refs so list/detail responses don't N+1.
    ref_report = relationship(
        "app.modules.reports.models.Report",
        foreign_keys=[ref_report_id],
        lazy="joined",
    )
    ref_composite = relationship(
        "CompositeReport",
        foreign_keys=[ref_composite_id],
        lazy="joined",
    )
