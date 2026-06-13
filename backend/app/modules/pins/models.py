"""WorkspacePinnedReport — 부서 홈에 고정한 '주요 보고서'.

부서(워크스페이스) 단위 핀: 그 부서 매니저가 중요한 보고서를 고정하면, 부서
홈의 '고정 보고서' 섹션에 멤버 모두에게 보인다(부서홈_대시보드_설계.md A).
개인 핀이 아니라 부서 공용이라 (workspace_slug, report_id) 단위.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class WorkspacePinnedReport(Base):
    __tablename__ = "workspace_pinned_reports"
    __table_args__ = (
        UniqueConstraint(
            "workspace_slug", "report_id", name="uq_workspace_pinned_report"
        ),
        # 부서 홈 조회: 그 부서의 핀들(표시 순서대로).
        Index("ix_workspace_pins_ws_order", "workspace_slug", "display_order"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workspace_slug: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("workspaces.slug", ondelete="CASCADE"),
        nullable=False,
    )
    report_id: Mapped[int] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"), nullable=False
    )
    # 누가 고정했는지(표시·감사용). 계정 삭제 시 핀은 남기고 끊는다.
    pinned_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # 표시 순서(작을수록 앞). 재정렬은 후속 — 현재는 고정 시각 순.
    display_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
