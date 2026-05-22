"""Business logic for report types."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.modules.report_types.models import ReportType, ReportTypeStatus
from app.modules.report_types.schemas import ReportTypeCreate, ReportTypeUpdate


def find_by_name_ci(db: Session, name: str) -> Optional[ReportType]:
    """Case-insensitive name lookup — prevents '주간보고' / '주간 보고'
    style near-duplicates from sneaking in through the picker."""
    return db.execute(
        select(ReportType).where(func.lower(ReportType.name) == name.strip().lower())
    ).scalar_one_or_none()


def list_visible(
    db: Session,
    *,
    user_id: int,
    is_admin: bool,
    q: Optional[str] = None,
    limit: int = 200,
) -> list[ReportType]:
    """List types the user can pick from.

    - Admin: sees everything (official + all unofficial) so they can
      reuse another user's pending type without re-creating it.
    - Non-admin: official + own unofficial.

    The optional `q` does case-insensitive substring matching on
    name + description so the picker can drive its filter server-side.
    """
    stmt = select(ReportType)
    if not is_admin:
        stmt = stmt.where(
            or_(
                ReportType.status == ReportTypeStatus.official,
                ReportType.created_by_user_id == user_id,
            )
        )
    if q:
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(ReportType.name).like(needle),
                func.lower(ReportType.description).like(needle),
            )
        )
    stmt = stmt.order_by(ReportType.status.desc(), ReportType.name).limit(limit)
    return list(db.execute(stmt).scalars())


def list_all_for_admin(
    db: Session, *, q: Optional[str] = None, limit: int = 500
) -> list[ReportType]:
    stmt = select(ReportType)
    if q:
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(ReportType.name).like(needle),
                func.lower(ReportType.description).like(needle),
            )
        )
    # Unofficial first so triage items surface at the top of the admin tab.
    stmt = stmt.order_by(ReportType.status.asc(), ReportType.created_at.desc()).limit(limit)
    return list(db.execute(stmt).scalars())


def get(db: Session, type_id: int) -> Optional[ReportType]:
    return db.get(ReportType, type_id)


def create(
    db: Session,
    payload: ReportTypeCreate,
    *,
    creator_user_id: int,
    is_admin: bool,
) -> ReportType:
    name = payload.name.strip()
    if not name:
        raise ValueError("이름은 비워둘 수 없습니다.")
    existing = find_by_name_ci(db, name)
    if existing is not None:
        # Pickers call create() optimistically when the user types a new
        # label; if the label already exists (regardless of status), hand
        # back the existing row so the report links to the canonical one.
        return existing

    # Admin creating from the admin tab → official by default (they can
    # still pass `status=unofficial` to seed a triage row if needed).
    # Non-admins always create unofficial — promotion is a separate
    # admin-only action.
    if is_admin:
        status_ = payload.status if payload.status is not None else ReportTypeStatus.official
    else:
        status_ = ReportTypeStatus.unofficial

    now = datetime.utcnow()
    row = ReportType(
        name=name,
        description=(payload.description or "").strip(),
        status=status_,
        created_by_user_id=creator_user_id,
        approved_by_user_id=creator_user_id if status_ == ReportTypeStatus.official else None,
        approved_at=now if status_ == ReportTypeStatus.official else None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def update(db: Session, row: ReportType, payload: ReportTypeUpdate) -> ReportType:
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        new_name = data["name"].strip()
        if not new_name:
            raise ValueError("이름은 비워둘 수 없습니다.")
        # Re-check the case-insensitive unique constraint against the new
        # name (excluding the row being edited).
        clash = db.execute(
            select(ReportType).where(
                func.lower(ReportType.name) == new_name.lower(),
                ReportType.id != row.id,
            )
        ).scalar_one_or_none()
        if clash is not None:
            raise ValueError(f"이미 같은 이름의 종류가 있습니다: {clash.name}")
        row.name = new_name
    if "description" in data and data["description"] is not None:
        row.description = data["description"].strip()
    db.commit()
    db.refresh(row)
    return row


def promote(db: Session, row: ReportType, approver_user_id: int) -> ReportType:
    if row.status == ReportTypeStatus.official:
        return row
    row.status = ReportTypeStatus.official
    row.approved_by_user_id = approver_user_id
    row.approved_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return row


def demote(db: Session, row: ReportType) -> ReportType:
    """Reverse a promote — admin can flag a type back to unofficial
    without deleting it (e.g. they want the author to revise the name
    first). Reports already linked to the type keep their link."""
    if row.status == ReportTypeStatus.unofficial:
        return row
    row.status = ReportTypeStatus.unofficial
    row.approved_by_user_id = None
    row.approved_at = None
    db.commit()
    db.refresh(row)
    return row


def delete(db: Session, row: ReportType) -> int:
    """Delete a type. Reports referencing it get their FK SET NULL
    (cascade declared at the column level). Returns the count of
    reports that were referencing it before deletion, so the UI can
    surface an "X reports were unlinked" message."""
    # Imported here to avoid a circular import at module load time.
    from app.modules.reports.models import Report

    orphan_count = (
        db.execute(
            select(func.count(Report.id)).where(Report.report_type_id == row.id)
        ).scalar()
        or 0
    )
    db.delete(row)
    db.commit()
    return int(orphan_count)
