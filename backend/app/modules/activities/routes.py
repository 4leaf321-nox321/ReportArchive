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
    WorkspaceActivityListResponse,
    WorkspaceActivityRead,
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
    if not report_services.can_read_report(db, actor, report):
        return error_response("Out of workspace scope", status_code=403)
    # 외부 공개 열람자(공개 경로 전용 또는 비멤버 public_viewer)에겐 이력 숨김.
    if not actor.workspace.virtual and (
        actor.public_viewer
        or report_services.is_public_only_viewer(db, actor, report)
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


@router.get("/workspace-activities")
def list_workspace_activities(
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """부서 홈 활동 피드 — 현재 부서(헤더 X-Workspace-Slug)에 게시/소유된
    보고서들의 최근 사건을 한데 모아 최신순으로.

    스코핑은 보고서 목록과 같은 모델을 재사용한다(list_reports_in_workspace):
    부서 게시판에 게시된 보고서(개인 공간이면 소유 보고서)만 대상이라
    권한이 자동으로 맞는다. 가상(_global) 컨텍스트·외부 공개 열람자에겐
    피드를 노출하지 않는다(빈 목록).
    """
    empty = WorkspaceActivityListResponse(items=[]).model_dump(mode="json")
    if actor.workspace.virtual or actor.public_viewer:
        return success_response(data=empty)

    reports = report_services.list_reports_in_workspace(db, actor.workspace.slug)
    title_by_id = {r.id: r.title for r in reports}
    if not title_by_id:
        return success_response(data=empty)

    rows = services.list_activities_for_reports(
        db, report_ids=list(title_by_id.keys()), limit=limit
    )
    actor_cache: dict[int, ActivityActorMini | None] = {}
    items = []
    for r in rows:
        actor_mini = None
        if r.actor_user_id is not None:
            if r.actor_user_id not in actor_cache:
                user = db.get(User, r.actor_user_id)
                actor_cache[r.actor_user_id] = (
                    ActivityActorMini.model_validate(user) if user else None
                )
            actor_mini = actor_cache[r.actor_user_id]
        items.append(
            WorkspaceActivityRead(
                id=r.id,
                report_id=r.report_id,
                report_title=title_by_id.get(r.report_id, ""),
                actor=actor_mini,
                type=r.type,
                payload=r.payload,
                created_at=r.created_at,
            )
        )
    return success_response(
        data=WorkspaceActivityListResponse(items=items).model_dump(mode="json")
    )
