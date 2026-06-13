"""부서 고정 보고서(핀) 서비스 — 부서 단위 CRUD + 소속 검증."""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.mounts.models import ReportMount
from app.modules.pins.models import WorkspacePinnedReport
from app.modules.reports.models import Report


class PinError(Exception):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def list_pins(db: Session, workspace_slug: str) -> list[WorkspacePinnedReport]:
    return list(
        db.execute(
            select(WorkspacePinnedReport)
            .where(WorkspacePinnedReport.workspace_slug == workspace_slug)
            .order_by(
                WorkspacePinnedReport.display_order, WorkspacePinnedReport.id
            )
        ).scalars()
    )


def report_belongs_to_workspace(db: Session, workspace_slug: str, report_id: int) -> bool:
    """이 부서에 고정할 수 있는 보고서인가 — 그 부서 게시판에 게시(mount)됐거나
    그 부서(개인 공간)가 소유한 보고서."""
    r = db.get(Report, report_id)
    if r is None:
        return False
    if r.workspace_slug == workspace_slug:
        return True
    mounted = db.execute(
        select(ReportMount.report_id).where(
            ReportMount.report_id == report_id,
            ReportMount.workspace_slug == workspace_slug,
        )
    ).first()
    return mounted is not None


def add_pin(
    db: Session, workspace_slug: str, report_id: int, actor_user_id: int | None
) -> WorkspacePinnedReport:
    if not report_belongs_to_workspace(db, workspace_slug, report_id):
        raise PinError("이 부서의 보고서만 고정할 수 있습니다.", status_code=400)
    existing = db.execute(
        select(WorkspacePinnedReport).where(
            WorkspacePinnedReport.workspace_slug == workspace_slug,
            WorkspacePinnedReport.report_id == report_id,
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing  # 멱등
    next_order = (
        db.execute(
            select(func.coalesce(func.max(WorkspacePinnedReport.display_order), -1)).where(
                WorkspacePinnedReport.workspace_slug == workspace_slug
            )
        ).scalar_one()
        + 1
    )
    row = WorkspacePinnedReport(
        workspace_slug=workspace_slug,
        report_id=report_id,
        pinned_by_user_id=actor_user_id,
        display_order=next_order,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def remove_pin(db: Session, workspace_slug: str, report_id: int) -> None:
    row = db.execute(
        select(WorkspacePinnedReport).where(
            WorkspacePinnedReport.workspace_slug == workspace_slug,
            WorkspacePinnedReport.report_id == report_id,
        )
    ).scalar_one_or_none()
    if row is None:
        return
    db.delete(row)
    db.commit()


def is_pinned(db: Session, workspace_slug: str, report_id: int) -> bool:
    return (
        db.execute(
            select(WorkspacePinnedReport.id).where(
                WorkspacePinnedReport.workspace_slug == workspace_slug,
                WorkspacePinnedReport.report_id == report_id,
            )
        ).first()
        is not None
    )
