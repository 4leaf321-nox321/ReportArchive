"""Saved-search request/response schemas.

`SavedSearchFilters` mirrors the frontend filter object (appendReportFilters) plus the
older entity/year/location scoping. `extra="ignore"` drops unknown keys so a stored
search never carries junk if the frontend shape drifts.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class SavedSearchFilters(BaseModel):
    """저장되는 필터 조합 — 값 있는 것만. 서버가 이걸 검색 파라미터로 되살린다."""

    model_config = ConfigDict(extra="ignore")

    # (B) 컬럼 필터
    dateField: Optional[str] = None          # report_date | created_at
    lastDays: Optional[int] = None
    period: Optional[str] = None             # today|yesterday|this_week|this_month|this_year
    dateFrom: Optional[str] = None           # YYYY-MM-DD
    dateTo: Optional[str] = None
    reportTypeIds: list[int] = Field(default_factory=list)
    authorIds: list[int] = Field(default_factory=list)
    # 작성자 칩 {id,name} — UI 복원용(서버 필터는 authorIds 사용). extra 는 무시.
    authors: list[dict] = Field(default_factory=list)
    editorIds: list[int] = Field(default_factory=list)
    phases: list[str] = Field(default_factory=list)
    lifecycles: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    # 엔티티/연도/위치(기존 필터)
    entityIds: list[int] = Field(default_factory=list)
    entityRollup: bool = False
    year: Optional[int] = None
    location: Optional[str] = None           # all|personal|boards
    board: Optional[str] = None
    sort: Optional[str] = None               # relevance|recent|oldest


class SavedSearchCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    query: str = ""
    mode: str = "keyword"
    filters: SavedSearchFilters = Field(default_factory=SavedSearchFilters)
    subscribed: bool = False
    notify_channel: str = "inapp"


class SavedSearchUpdate(BaseModel):
    """부분 갱신 — 준 필드만 반영."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    query: Optional[str] = None
    mode: Optional[str] = None
    filters: Optional[SavedSearchFilters] = None
    subscribed: Optional[bool] = None
    notify_channel: Optional[str] = None


class SavedSearchRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    query: str
    mode: str
    filters: dict
    subscribed: bool
    notify_channel: str
    last_notified_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
