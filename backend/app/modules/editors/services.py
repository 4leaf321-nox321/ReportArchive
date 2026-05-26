"""Editor grant service layer — Phase 3.

`ReportEditor` rows model "추가 편집자" — escape hatch for cross-team
collaborators outside the lead/coauthor auto-grant paths. Owner-only
operations.

`can_edit()` (app.shared.permissions) consults this table; this module
just maintains it.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.editors.models import ReportEditor
from app.modules.users.models import User


def add_editor(
    db: Session,
    *,
    report_id: int,
    user_id: int,
    added_by_user_id: int,
) -> ReportEditor:
    """Idempotent. If the user is already an editor, returns the
    existing row without bumping `added_at` (audit stays accurate)."""
    existing = db.get(ReportEditor, (report_id, user_id))
    if existing is not None:
        return existing
    row = ReportEditor(
        report_id=report_id,
        user_id=user_id,
        added_by_user_id=added_by_user_id,
        added_at=datetime.utcnow(),
    )
    db.add(row)
    db.flush()
    return row


def remove_editor(
    db: Session, *, report_id: int, user_id: int
) -> bool:
    """Returns True if a row was removed, False if not found."""
    row = db.get(ReportEditor, (report_id, user_id))
    if row is None:
        return False
    db.delete(row)
    db.flush()
    return True


def list_editors(db: Session, *, report_id: int) -> list[ReportEditor]:
    rows = db.execute(
        select(ReportEditor)
        .where(ReportEditor.report_id == report_id)
        .order_by(ReportEditor.added_at.asc())
    ).scalars()
    return list(rows)


def get_editor_users(db: Session, *, report_id: int) -> list[User]:
    """Convenience for the list endpoint — joined User rows."""
    rows = db.execute(
        select(User)
        .join(ReportEditor, ReportEditor.user_id == User.id)
        .where(ReportEditor.report_id == report_id)
        .order_by(User.name.asc())
    ).scalars()
    return list(rows)
