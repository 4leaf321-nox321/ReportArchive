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


class AccessLogStatPoint(BaseModel):
    """한 시간 버킷(일/주/월)의 부서별 접속 건수."""

    # 표시용 라벨(예: '6/24', '6/24~', '2026.06').
    label: str
    # 버킷 시작일(KST, 'YYYY-MM-DD'). 막대 클릭 시 드릴다운 조회 키로 쓴다.
    bucket_start: str
    # 이 버킷의 전체 접속 건수(부서 합).
    total: int
    # 부서명 → 건수. 건수 0인 부서는 생략(스파스).
    counts: dict[str, int]


class AccessLogStatsResponse(BaseModel):
    """부서별·기간별 접속 통계(막대그래프용)."""

    granularity: str  # 'day' | 'week' | 'month'
    success: bool | None  # True=성공만, False=실패만, None=전체
    # 막대 스택 순서대로의 부서명 목록(전체 건수 내림차순, '미지정' 마지막).
    departments: list[str]
    # 시간순(과거→현재) 버킷.
    points: list[AccessLogStatPoint]


class AccessLogUserCount(BaseModel):
    """드릴다운 — 한 구간(버킷[+부서]) 안에서 사용자 1명의 접속 횟수."""

    user_id: int | None
    name: str | None  # 현재 사용자 이름(삭제/미가입이면 None)
    email: str
    department: str  # 사용자 홈 부서명(없으면 '미지정')
    count: int


class AccessLogBreakdownResponse(BaseModel):
    """막대(버킷[+부서]) 클릭 시 — 그 구간의 사용자별 접속 횟수(내림차순)."""

    total: int
    users: list[AccessLogUserCount]
