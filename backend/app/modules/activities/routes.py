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
from app.modules.reports import services as report_services
from app.modules.users.models import User
from app.shared.auth import CurrentUser, get_current_user
from app.shared.responses import error_response, not_found_response, success_response


router = APIRouter()


@router.get("/reports/{report_id}/activities")
def list_report_activities(
    report_id: int,
    limit: int = Query(default=50, ge=1, le=200),
    before_id: int | None = Query(default=None, ge=1),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Newest-first timeline for the report. Cursor pagination via
    `before_id` — passing the smallest id of the previous page returns
    the next page.

    Visibility: 보고서를 볼 수 있는 멤버 열람자만(코멘트 권한 모델과 동일).
    외부 공개 열람자(조직간공개_설계.md §6)에겐 수정 이력을 숨긴다(빈 목록) —
    "본문+첨부만 읽기전용" 원칙. 스코프 밖이면 403.
    """
    report = report_services.get_report(db, report_id)
    if report is None:
        return not_found_response(f"보고서를 찾을 수 없습니다: {report_id}")
    if not actor.workspace.virtual and not report_services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        return error_response("Out of workspace scope", status_code=403)
    # 외부 공개 열람자에겐 이력 숨김(빈 목록).
    if not actor.workspace.virtual and report_services.is_public_only_viewer(
        db, report, actor.workspace.slug
    ):
        return success_response(
            data=ActivityListResponse(items=[]).model_dump(mode="json")
        )
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
