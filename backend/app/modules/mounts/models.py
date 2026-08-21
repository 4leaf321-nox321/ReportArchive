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
    ForeignKeyConstraint,
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
    # 작성자 + 그 게시판 매니저만 편집(공유/권한 개편 후 재도입). grant 로는
    # 그 게시판에 view + workspace_manager(edit) 으로 표현.
    manager = "manager"


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

    # Org-folder placement on this board. 0개 = "미분류". 같은 보고서가
    # 게시판마다 다른 폴더에 놓일 수 있고(폴더는 mount 속성이지 report
    # 속성이 아니다), **한 게시판 안에서도 여러 폴더에 동시에 놓일 수
    # 있다**(p89) — 그래서 컬럼이 아니라 자식 테이블이다.
    folder_links: Mapped[list["ReportMountFolder"]] = relationship(
        "ReportMountFolder",
        lazy="selectin",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="ReportMountFolder.folder_id",
    )

    # Eager-loaded so the personal-list "게시" cell can render the
    # workspace's Korean name without a second roundtrip per mount.
    # Pairs with Report.mounts (lazy=selectin) — the SELECT IN already
    # joins workspaces, so adding the name is free.
    workspace: Mapped["Workspace"] = relationship(  # noqa: F821
        "Workspace",
        lazy="joined",
    )

    @property
    def folder_ids(self) -> list[int]:
        """이 게시판에서 이 보고서가 놓인 폴더 id 들(오름차순). 빈 리스트=미분류."""
        return sorted(link.folder_id for link in self.folder_links)

    @property
    def folder_id(self) -> int | None:
        """대표 폴더 — 다중 폴더 이전(p89) API 를 쓰는 호출부용 호환 뷰.
        폴더가 여러 개면 첫 번째, 미분류면 None. 쓰기는 folder_links 로만."""
        ids = self.folder_ids
        return ids[0] if ids else None


class ReportMountFolder(Base):
    """한 게시(mount)의 폴더 배치 한 건 — (보고서, 게시판, 폴더).

    p89 이전엔 `report_mounts.folder_id` 단일 컬럼이라 "한 게시판에 한 폴더"가
    스키마로 강제됐다. 실제로는 같은 보고서를 한 부서 게시판의 여러 폴더에
    (예: '2026년 정기보고' + 'NVH 해석') 걸어두고 싶은 요구가 있어, 배치를
    자식 테이블로 분리했다.

    - 행이 0개면 그 게시판에서 **미분류**.
    - (report_id, workspace_slug) 복합 FK → report_mounts CASCADE 라
      게시취소(unmount) 시 배치도 함께 사라진다.
    - folder CASCADE — 폴더를 지우면 그 배치만 사라지고, 남은 배치가 없으면
      자연스럽게 미분류로 떨어진다(옛 SET NULL 과 같은 결과).
    """

    __tablename__ = "report_mount_folders"
    __table_args__ = (
        ForeignKeyConstraint(
            ["report_id", "workspace_slug"],
            ["report_mounts.report_id", "report_mounts.workspace_slug"],
            ondelete="CASCADE",
            name="fk_report_mount_folders_mount",
        ),
        # 폴더별 카운트/필터가 가장 잦은 질의 — 폴더 선두 인덱스.
        Index("ix_report_mount_folders_folder", "folder_id"),
        Index("ix_report_mount_folders_board", "workspace_slug", "folder_id"),
    )

    report_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    workspace_slug: Mapped[str] = mapped_column(String(64), primary_key=True)
    folder_id: Mapped[int] = mapped_column(
        ForeignKey("folders.id", ondelete="CASCADE"), primary_key=True
    )

    # 폴더 이름을 쓰는 곳(목록 칩·MCP 응답)이 id→이름 조회를 따로 하지 않도록.
    # folder_links 자체가 selectin 이라 여기 joined 를 얹어도 왕복이 늘지 않는다.
    folder: Mapped["Folder"] = relationship(  # noqa: F821
        "Folder", lazy="joined"
    )


class TakedownStatus(str, enum.Enum):
    """게시취소 요청 상태.

    - pending  — 접수, 그 게시판 매니저의 처리 대기.
    - approved — 매니저 승인 → 그 게시판에서 게시취소(unmount)됨.
    - rejected — 매니저 거절 → 그 게시판 게시 유지(부서가 보존 결정).
    - canceled — 요청 철회(작성자 직접 / 휴지통 복구 시 자동).
    """

    pending = "pending"
    approved = "approved"
    rejected = "rejected"
    canceled = "canceled"


class ReportTakedownRequest(Base):
    """게시판별 게시취소 요청 큐 (보고서 삭제 재설계 2단계).

    작성자가 "게시판에서 내리기"를 요청하면, 보고서가 게시(mount)된 부서
    게시판마다 한 건씩 pending 으로 쌓인다(팬아웃). 각 게시판 매니저가
    자기 board 건만 승인/거절한다 — 승인하면 그 게시판에서 게시취소되고,
    거절하면 그 게시판엔 게시가 유지된다(부서 보존 결정). PasswordResetRequest
    요청 큐 패턴을 따른다.
    """

    __tablename__ = "report_takedown_requests"
    __table_args__ = (
        # 게시판별 큐 조회(매니저가 자기 board 의 pending 을 본다).
        Index("ix_takedown_workspace_status", "workspace_slug", "status"),
        Index("ix_takedown_report", "report_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    report_id: Mapped[int] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"), nullable=False
    )
    # 게시취소 대상 게시판(이 보고서가 게시된 org board).
    workspace_slug: Mapped[str] = mapped_column(
        ForeignKey("workspaces.slug", ondelete="CASCADE"), nullable=False
    )
    requested_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[TakedownStatus] = mapped_column(
        Enum(TakedownStatus, name="takedown_status_enum"),
        default=TakedownStatus.pending,
        server_default="pending",
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    decided_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    report: Mapped["Report"] = relationship(  # noqa: F821
        "Report", foreign_keys=[report_id]
    )
    workspace: Mapped["Workspace"] = relationship(  # noqa: F821
        "Workspace", foreign_keys=[workspace_slug], lazy="joined"
    )
    requested_by: Mapped["User | None"] = relationship(  # noqa: F821
        "User", foreign_keys=[requested_by_user_id]
    )
