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
