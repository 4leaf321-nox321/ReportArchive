"""Saved-search services — 사용자별 CRUD(소유권 강제).

조건만 저장하고 결과는 저장하지 않는다(라이브). 구독 감지·알림 발송은 후속(#2)에서
jobs 스케줄러가 subscribed=True 인 것들을 훑어 seen_watermark 이후 보고서를 찾는다.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.saved_searches.models import SavedSearch
from app.modules.saved_searches.schemas import (
    SavedSearchCreate,
    SavedSearchUpdate,
)

_VALID_MODES = ("keyword", "semantic")
_VALID_CHANNELS = ("inapp", "email", "both")


def _clean_mode(m: Optional[str]) -> str:
    return m if m in _VALID_MODES else "keyword"


def _clean_channel(c: Optional[str]) -> str:
    return c if c in _VALID_CHANNELS else "inapp"


def list_saved_searches(db: Session, user_id: int) -> list[SavedSearch]:
    """내 저장검색 — 이름순."""
    return list(
        db.execute(
            select(SavedSearch)
            .where(SavedSearch.user_id == user_id)
            .order_by(SavedSearch.name)
        ).scalars()
    )


def get_saved_search(db: Session, user_id: int, sid: int) -> Optional[SavedSearch]:
    """소유자 본인 것만 반환(남의 것/없으면 None)."""
    row = db.get(SavedSearch, sid)
    if row is None or row.user_id != user_id:
        return None
    return row


def create_saved_search(
    db: Session, user_id: int, payload: SavedSearchCreate
) -> SavedSearch:
    row = SavedSearch(
        user_id=user_id,
        name=payload.name.strip(),
        query=payload.query or "",
        mode=_clean_mode(payload.mode),
        filters=payload.filters.model_dump(),
        subscribed=bool(payload.subscribed),
        notify_channel=_clean_channel(payload.notify_channel),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def update_saved_search(
    db: Session, user_id: int, sid: int, payload: SavedSearchUpdate
) -> Optional[SavedSearch]:
    row = get_saved_search(db, user_id, sid)
    if row is None:
        return None
    if payload.name is not None:
        row.name = payload.name.strip()
    if payload.query is not None:
        row.query = payload.query
    if payload.mode is not None:
        row.mode = _clean_mode(payload.mode)
    if payload.filters is not None:
        row.filters = payload.filters.model_dump()
    if payload.subscribed is not None:
        row.subscribed = bool(payload.subscribed)
        # 구독을 켤 때 워터마크를 지금으로 — 이후 생성분만 '새 것'.
        if payload.subscribed and row.seen_watermark is None:
            from sqlalchemy import func as _f

            row.seen_watermark = db.scalar(select(_f.now()))
    if payload.notify_channel is not None:
        row.notify_channel = _clean_channel(payload.notify_channel)
    db.commit()
    db.refresh(row)
    return row


def delete_saved_search(db: Session, user_id: int, sid: int) -> bool:
    row = get_saved_search(db, user_id, sid)
    if row is None:
        return False
    db.delete(row)
    db.commit()
    return True
