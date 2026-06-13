"""Access-log read schemas (admin view)."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class AccessLogRead(BaseModel):
    id: int
    user_id: int | None
    # 표시용 현재 사용자 이름(LEFT JOIN). 계정 삭제/미가입이면 None.
    name: str | None
    email: str
    event: str
    success: bool
    ip_address: str | None
    user_agent: str | None
    created_at: datetime


class AccessLogPage(BaseModel):
    items: list[AccessLogRead]
    total: int
