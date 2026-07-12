"""경보 API 스키마 (Phase D 1단계)."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class AlertRuleRead(BaseModel):
    id: int
    name: str
    enabled: bool
    probe_key: str
    params: dict
    severity: str
    schedule_kind: str = "manual"
    interval_minutes: Optional[int] = None
    next_run_at: Optional[datetime] = None
    last_run_at: Optional[datetime] = None
    last_status: Optional[str] = None
    firing_count: int = 0  # 현재 발화 중인 대상 수(파생 — 상태 테이블 카운트)

    class Config:
        from_attributes = True


class AlertRuleListResponse(BaseModel):
    items: list[AlertRuleRead]


class AlertRuleUpdate(BaseModel):
    """프론트에서 조정 가능한 값만. 보낸 필드만 반영(exclude_unset)."""
    enabled: Optional[bool] = None
    params: Optional[dict] = None  # {days:int, mounted_only:bool}
    schedule_kind: Optional[str] = None  # 'manual' | 'interval'
    interval_minutes: Optional[int] = None


class RunResult(BaseModel):
    """수동 실행 요약 — 이번 실행에서 새로 발화/해소된 수 + 현재 발화 총계."""
    checked: int      # 프로브가 반환한 현재 매칭 대상 수
    fired: int        # 이번에 새로 발화(신규 진입)
    resolved: int     # 이번에 해소(이탈)
    firing: int       # 현재 발화 중 총계
    capped: bool = False  # 프로브 상한(500)에 걸려 잘렸는지


class FiringItem(BaseModel):
    target_type: str
    target_id: str
    context: dict
    first_fired_at: datetime
    last_seen_at: datetime


class FiringListResponse(BaseModel):
    items: list[FiringItem]
    total: int = 0  # 현재 발화 중 총계(페이지네이션용)
