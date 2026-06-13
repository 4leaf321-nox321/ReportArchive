"""Pydantic schemas — TemplateMetric 관리 API (시스템 관리자)."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

AggLiteral = Literal["sum", "avg", "min", "max", "count", "last"]


class TemplateMetricRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    template_id: str
    block_id: str
    field_key: Optional[str] = None
    source_kind: str
    agg: str
    label: str
    unit: str
    enabled: bool
    display_order: int


class TemplateMetricCreate(BaseModel):
    template_id: str = Field(..., min_length=1, max_length=64)
    block_id: str = Field(..., min_length=1, max_length=64)
    field_key: Optional[str] = Field(default=None, max_length=64)
    source_kind: Literal["key_value"] = "key_value"
    agg: AggLiteral = "avg"
    label: str = Field(..., min_length=1, max_length=128)
    unit: str = Field(default="", max_length=32)
    enabled: bool = True
    display_order: int = 0


class TemplateMetricUpdate(BaseModel):
    """부분 수정 — 보낸 필드만 반영."""

    agg: Optional[AggLiteral] = None
    label: Optional[str] = Field(default=None, min_length=1, max_length=128)
    unit: Optional[str] = Field(default=None, max_length=32)
    enabled: Optional[bool] = None
    display_order: Optional[int] = None


class MetricFieldCandidate(BaseModel):
    """템플릿 schema 에서 지표로 쓸 만한 숫자 필드 후보."""

    key: str
    label: str
    type: str  # number | integer


class MetricBlockCandidate(BaseModel):
    """key_value 블록 + 그 안의 숫자 필드 후보."""

    block_id: str
    block_label: str
    fields: list[MetricFieldCandidate]


class MetricCandidatesResponse(BaseModel):
    template_id: str
    template_name: str
    version: int
    blocks: list[MetricBlockCandidate]
