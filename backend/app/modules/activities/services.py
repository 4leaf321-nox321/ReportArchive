"""Activity service layer — single producer function + read query.

`record_activity` is the only write entrypoint, called as a side effect
from other modules' services (mounts, comments, reports, …). No
notification semantics — the inbox lives in `notifications`; this table
is just "what happened" history, not "who needs to see it".
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.modules.activities.models import ReportActivity, ReportActivityType


def record_activity(
    db: Session,
    *,
    report_id: int,
    type: ReportActivityType,
    actor_user_id: Optional[int] = None,
    payload: Optional[dict] = None,
) -> ReportActivity:
    """Insert a single activity row. Caller controls the transaction —
    we flush (so the row gets an id within the same session) but do not
    commit. Used as a side effect, so the activity row commits/rolls
    back atomically with the action it records."""
    row = ReportActivity(
        report_id=report_id,
        type=type,
        actor_user_id=actor_user_id,
        payload=payload or {},
    )
    db.add(row)
    db.flush()
    return row


def list_activities_for_report(
    db: Session,
    *,
    report_id: int,
    limit: int = 100,
    before_id: Optional[int] = None,
) -> list[ReportActivity]:
    """Newest first. `before_id` lets the frontend paginate by passing
    the last-seen id (cursor pattern; cheaper than offset on a growing
    log)."""
    query = select(ReportActivity).where(ReportActivity.report_id == report_id)
    if before_id is not None:
        query = query.where(ReportActivity.id < before_id)
    query = query.order_by(desc(ReportActivity.id)).limit(min(limit, 500))
    return list(db.execute(query).scalars())
