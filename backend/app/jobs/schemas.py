"""Job 조회용 Pydantic 스키마 (폴링 응답)."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    type: str
    status: str
    attempts: int
    max_attempts: int
    result: Optional[dict] = None
    last_error: Optional[str] = None
    run_after: datetime
    created_at: datetime
    updated_at: datetime


class JobAdminRead(BaseModel):
    """관리자 "작업 큐" 탭용 — 본인 한정 JobRead 에 운영 진단 필드를 더한다."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    type: str
    status: str
    attempts: int
    max_attempts: int
    last_error: Optional[str] = None
    result: Optional[dict] = None
    run_after: datetime
    created_at: datetime
    updated_at: datetime
    created_by: Optional[int] = None
    worker_id: Optional[str] = None
    locked_at: Optional[datetime] = None
