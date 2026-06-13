"""Dashboard route — server-aggregated per-workspace dashboard (Phase 3A).

  GET /api/dashboard?from=<date>&to=<date>&unit=week|month

부서 컨텍스트는 헤더(X-Workspace-Slug)로 잡는다(listReports 등과 동일 →
권한 자동). 외부 공개 열람자에겐 빈 집계.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.dashboard import services
from app.modules.dashboard.schemas import CrosstabResponse, DashboardResponse
from app.shared.auth import CurrentUser, get_current_user
from app.shared.responses import success_response


router = APIRouter()


@router.get("/dashboard")
def get_dashboard(
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = Query(default=None),
    unit: str = Query(default="week"),
    include_descendants: bool = Query(default=False),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """부서 대시보드 집계. from/to 생략 시 전체 기간. unit: 추세 버킷(week|month).
    include_descendants=True 면 하위 부서 게시판까지 포함."""
    if unit not in ("week", "month", "year"):
        unit = "week"

    # 외부 공개 열람자(비멤버 읽기전용)에겐 곁다리 집계를 노출하지 않는다.
    if getattr(actor, "public_viewer", False):
        empty = DashboardResponse(
            kpis={"total": 0, "authors": 0, "templates": 0},
            phase_breakdown={"drafting": 0, "reviewing": 0, "finalized": 0},
            trend=[],
            health={"stale_drafts": 0, "uncategorized": 0, "open_comments": 0},
            distributions=[],
            author_top={"top": [], "distinct": 0, "unknown": 0},
        )
        return success_response(data=empty.model_dump(mode="json"))

    data = services.compute_dashboard(
        db,
        actor=actor,
        date_from=from_,
        date_to=to,
        unit=unit,
        include_descendants=include_descendants,
    )
    return success_response(
        data=DashboardResponse.model_validate(data).model_dump(mode="json")
    )


@router.get("/dashboard/crosstab")
def get_dashboard_crosstab(
    row: str = Query(...),
    col: str = Query(...),
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = Query(default=None),
    include_descendants: bool = Query(default=False),
    full: bool = Query(default=False),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """두 메타데이터 차원의 교차표. row/col 은 차원 키
    (entity:<slug> | report_type | template). full=True 면 행/열 상한 확대."""
    empty = CrosstabResponse(
        row_label="", col_label="", rows=[], cols=[], cells={}
    )
    if getattr(actor, "public_viewer", False):
        return success_response(data=empty.model_dump(mode="json"))
    data = services.compute_crosstab(
        db,
        actor=actor,
        date_from=from_,
        date_to=to,
        row=row,
        col=col,
        include_descendants=include_descendants,
        top=services.CROSSTAB_FULL_N if full else services.CROSSTAB_TOP_N,
    )
    return success_response(
        data=CrosstabResponse.model_validate(data).model_dump(mode="json")
    )
