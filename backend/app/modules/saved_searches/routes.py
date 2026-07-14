"""Saved-search routes — /api/saved-searches (내 스마트 폴더 CRUD).

워크스페이스 컨텍스트 불필요(사용자 소유 리소스) → get_current_user_no_workspace.
적용(검색 실행)은 프론트가 저장된 filters 를 기존 /reports/search 로 되살려 돌린다 —
별도 실행 엔드포인트 없음. 구독 감지·알림은 후속(#2) 스케줄러가 담당.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.saved_searches import services
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
