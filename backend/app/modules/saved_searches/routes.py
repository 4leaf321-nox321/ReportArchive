"""Saved-search routes — /api/saved-searches (내 스마트 폴더 CRUD).

워크스페이스 컨텍스트 불필요(사용자 소유 리소스) → get_current_user_no_workspace.
적용(검색 실행)은 프론트가 저장된 filters 를 기존 /reports/search 로 되살려 돌린다.
다만 **AI(MCP)는 그렇게 못 한다** — 저장 필터는 id·camelCase 라 MCP 도구 어휘와
다르고, 모델이 손으로 옮기면 조용히 어긋난다. 그래서 서버가 돌려주는
`GET /{sid}/results` 를 둔다(구독 알림과 **같은 필터 경로** 재사용).
구독 감지·알림은 스케줄러가 담당.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.saved_searches import services, subscriptions
from app.modules.saved_searches.schemas import (
    SavedSearchCreate,
    SavedSearchRead,
    SavedSearchUpdate,
)
from app.modules.users.models import User
from app.shared.auth import get_current_user_no_workspace
from app.shared.responses import (
    created_response,
    not_found_response,
    success_response,
)

router = APIRouter()


@router.get("")
def list_mine(
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    """내 저장검색 목록(이름순)."""
    rows = services.list_saved_searches(db, actor.id)
    return success_response(
        data=[SavedSearchRead.model_validate(r) for r in rows]
    )


@router.post("")
def create(
    payload: SavedSearchCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    """현재 검색어·모드·필터 조합을 저장."""
    row = services.create_saved_search(db, actor.id, payload)
    return created_response(data=SavedSearchRead.model_validate(row))


@router.patch("/{sid}")
def update(
    sid: int,
    payload: SavedSearchUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    """이름·필터·구독 등 부분 갱신(내 것만)."""
    row = services.update_saved_search(db, actor.id, sid, payload)
    if row is None:
        return not_found_response("저장검색을 찾을 수 없습니다.")
    return success_response(data=SavedSearchRead.model_validate(row))


@router.delete("/{sid}")
def delete(
    sid: int,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    """저장검색 삭제(내 것만)."""
    ok = services.delete_saved_search(db, actor.id, sid)
    if not ok:
        return not_found_response("저장검색을 찾을 수 없습니다.")
    return success_response(data={"deleted": True})


@router.get("/{sid}/results")
def results(
    sid: int,
    limit: int = Query(default=30, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user_no_workspace),
):
    """저장검색을 **지금 실행**해 걸리는 보고서 목록을 돌려준다(내 것만).

    구독 알림이 쓰는 것과 **같은 필터 경로**(`matching_report_ids`)를 탄다 — 갈라지면
    "알림은 왔는데 열어보니 없다" 가 된다. 알림과 다른 점은 watermark 를 안 보는
    것뿐이다(새 것만이 아니라 **전부**).

    반환 형태는 `/reports/browse` 와 같다(소비자가 두 벌 배우지 않게)."""
    from sqlalchemy import select

    from app.modules.reports.models import Report
    from app.modules.reports.routes import browse_projection

    saved = services.get_saved_search(db, actor.id, sid)
    if saved is None:
        return not_found_response("저장검색을 찾을 수 없습니다.")

    base = subscriptions.matching_report_ids(db, actor.id, saved)
    conds = [Report.deleted_at.is_(None)]
    if base is not None:
        if not base:
            return success_response(data={
                "saved_search": {"id": saved.id, "name": saved.name,
                                 "query": saved.query, "subscribed": saved.subscribed},
                "reports": [], "total": 0, "limit": limit, "offset": offset,
                "has_more": False,
            })
        conds.append(Report.id.in_(base))
    for tok in (saved.query or "").split():
        conds.append(Report.search_text.ilike(f"%{tok}%"))

    total = db.execute(
        select(func.count()).select_from(Report).where(*conds)
    ).scalar_one()
    rows = db.execute(
        select(Report).where(*conds)
        .order_by(Report.updated_at.desc())
        .limit(limit).offset(offset)
    ).scalars().all()
    items = browse_projection(db, rows, (saved.query or "").strip())
    return success_response(data={
        "saved_search": {"id": saved.id, "name": saved.name,
                         "query": saved.query, "subscribed": saved.subscribed},
        "reports": items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(items) < total,
    })
