"""Activity routes — read-only timeline of a report's events.

Mounted under `/api/reports/{report_id}/activities` via the reports
router so the URL reflects ownership (and the auth check reuses the
same workspace visibility chain as other report endpoints).

Phase 2E ships only the GET; record_activity writes happen inside
other modules' services.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.activities import models as _models  # noqa: F401
from app.modules.activities import services
from app.modules.activities.schemas import (
    ActivityActorMini,
    ActivityListResponse,
    ActivityRead,
)
from app.modules.users.models import User
from app.shared.auth import get_current_user_no_workspace
from app.shared.responses import success_response


router = APIRouter()


@router.get("/reports/{report_id}/activities")
def list_report_activities(
    report_id: int,
    limit: int = Query(default=50, ge=1, le=200),
    before_id: int | None = Query(default=None, ge=1),
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    """Newest-first timeline for the report. Cursor pagination via
    `before_id` — passing the smallest id of the previous page returns
    the next page.

    Visibility: any authenticated user can read (matches the comments
    permission model — if you can see the report you can see what
    happened to it). Activity rows don't carry secrets; private edits
    are differentiated only by who the actor was.
    """
    rows = services.list_activities_for_report(
        db, report_id=report_id, limit=limit, before_id=before_id
    )
    items = []
    for r in rows:
        actor_mini = None
        if r.actor_user_id is not None:
            user = db.get(User, r.actor_user_id)
            if user is not None:
                actor_mini = ActivityActorMini.model_validate(user)
        items.append(
            ActivityRead(
                id=r.id,
                report_id=r.report_id,
                actor=actor_mini,
                type=r.type,
                payload=r.payload,
                created_at=r.created_at,
            )
        )
    return success_response(
        data=ActivityListResponse(items=items).model_dump(mode="json")
    )
