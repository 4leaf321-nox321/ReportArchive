"""ReportMount — the link that promotes a personal-space report to an
organizational board (게시).

The mount is a *live reference*, not a snapshot — when the report owner
edits the source in their personal workspace, every org board where the
report is mounted reflects the change immediately. This is what makes the
"엔지니어가 분석 보고서를 보강 → 종합보고에 그대로 반영" workflow
possible without manual copy-paste each week.

The `edit_policy` column controls who, beyond the author, may edit the
report when accessed through this mount. The same report can be mounted
to multiple boards with different policies (e.g. "팀1 게시판에선 보직장
편집 가능, 본부 게시판에선 본인만"). The full permission resolution
lives in `can_edit()` (see 협업개선_설계.md §4.5).

Phase 0 only defines the table; the actual mount/unmount API + UI lands
in Phase 1. `edit_policy` ships with values but is uniformly `default`
until Phase 3 wires the per-mount picker.
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
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class MountEditPolicy(str, enum.Enum):
    """How the source report's edit rights surface for mount viewers.

    - default    — 작성자 + 보직장 (해당 게시판 lead). 한국 조직 기본.
    - owner_only — 작성자만. 보직장 자동 권한도 차단 (외부 제출 직전 등).
    - coauthor   — 게시판 멤버 전원 편집. 팀 공동 작성 보고서용.
    """

    default = "default"
    owner_only = "owner_only"
    coauthor = "coauthor"


class ReportMount(Base):
    __tablename__ = "report_mounts"
    __table_args__ = (
        Index("ix_report_mounts_workspace", "workspace_slug"),
        Index("ix_report_mounts_mounted_by", "mounted_by_user_id"),
    )

    # Composite PK — a report appears at most once on a given board.
    report_id: Mapped[int] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"), primary_key=True
    )
    workspace_slug: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("workspaces.slug", ondelete="CASCADE"),
        primary_key=True,
    )

    # Per-mount edit policy. See MountEditPolicy.
    edit_policy: Mapped[MountEditPolicy] = mapped_column(
        Enum(MountEditPolicy, name="mount_edit_policy_enum"),
        default=MountEditPolicy.default,
        server_default=MountEditPolicy.default.value,
        nullable=False,
    )

    # Who clicked "게시" and when. Useful for the audit trail and for
    # the "박과장이 [모델A]를 [팀1]에 게시했습니다" notification body.
    mounted_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    mounted_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    # Free-form note shown next to the mounted card on the org board
    # ("왜 이 게시판에 올렸나"). Optional.
    note: Mapped[str] = mapped_column(Text, default="", nullable=False)

    # Org-folder placement on this board. NULL = "미분류" on the org
    # listing. The same Report can sit in different folders on
    # different boards (folder is a mount attribute, not a report
    # attribute) — that's the whole reason this lives here and not on
    # Report itself. FK target's ondelete=SET NULL so deleting an org
    # folder un-files mounts back to 미분류.
    folder_id: Mapped[int | None] = mapped_column(
        ForeignKey("folders.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # Eager-loaded so the personal-list "게시" cell can render the
    # workspace's Korean name without a second roundtrip per mount.
    # Pairs with Report.mounts (lazy=selectin) — the SELECT IN already
    # joins workspaces, so adding the name is free.
    workspace: Mapped["Workspace"] = relationship(  # noqa: F821
        "Workspace",
        lazy="joined",
    )
