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


class EntityCount(BaseModel):
    id: int
    label: str
    count: int


class EntityCoverage(BaseModel):
    top: list[EntityCount]
    no_entity: int
    distinct: int


class AuthorTop(BaseModel):
    top: list[LabelCount]
    distinct: int
    unknown: int


class DashboardResponse(BaseModel):
    kpis: DashboardKpis
    phase_breakdown: PhaseBreakdown
    trend: list[TrendBucket]
    health: HealthBlock
    entity_coverage: EntityCoverage
    author_top: AuthorTop
    # 3B 에서 채움. 3A 단계에선 빈 배열.
    content_metrics: list = []
