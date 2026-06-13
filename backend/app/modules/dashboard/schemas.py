"""Pydantic schemas for the server-aggregated dashboard.

Phase 3A — the dashboard's per-workspace aggregates move server-side so
the client no longer pulls every report to compute them. The response
shape mirrors what `DashboardPage.jsx` already consumes so the frontend
cutover is a single useAsync swap (Phase3_대시보드_설계.md).
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class KpiCounts(BaseModel):
    total: int
    authors: int
    templates: int


class DashboardKpis(KpiCounts):
    # 직전 동일 길이 기간(전기 대비 Δ용). 전체기간이면 None.
    prev: Optional[KpiCounts] = None


class PhaseBreakdown(BaseModel):
    drafting: int
    reviewing: int
    finalized: int


class TrendBucket(BaseModel):
    key: str
    label: str
    count: int


class HealthBlock(BaseModel):
    stale_drafts: int
    uncategorized: int
    open_comments: int


class LabelCount(BaseModel):
    label: str
    count: int


class DistItem(BaseModel):
    label: str
    count: int
    # 막대 클릭 드릴다운 식별자 — 차원에 맞는 것 하나만 채워진다.
    entity_id: Optional[int] = None
    report_type_id: Optional[int] = None
    template_id: Optional[str] = None


class Distribution(BaseModel):
    """한 메타데이터 차원의 분포 — 차원 선택 드롭다운 1개 카드용."""

    key: str          # 'entity:model' | 'report_type' | 'template'
    label: str        # 드롭다운 표시명(예: '모델명', '종류', '템플릿')
    items: list[DistItem]
    no_value: int     # 이 차원 값이 없는 보고서 수


class AuthorTop(BaseModel):
    top: list[LabelCount]
    distinct: int
    unknown: int


class CrosstabHeader(BaseModel):
    key: str
    label: str
    entity_id: Optional[int] = None
    report_type_id: Optional[int] = None
    template_id: Optional[str] = None


class CrosstabResponse(BaseModel):
    """두 메타데이터 차원의 교차표(행×열 보고서 수). 셀 클릭 → 두 필터 동시 적용."""

    row_label: str
    col_label: str
    rows: list[CrosstabHeader]
    cols: list[CrosstabHeader]
    # cells[row.key][col.key] = count (0 인 셀은 생략)
    cells: dict[str, dict[str, int]]


class DashboardResponse(BaseModel):
    kpis: DashboardKpis
    phase_breakdown: PhaseBreakdown
    trend: list[TrendBucket]
    health: HealthBlock
    distributions: list[Distribution]
    author_top: AuthorTop
    # 3B 에서 채움. 3A 단계에선 빈 배열.
    content_metrics: list = []
