"""HTML embed bundle schemas."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class BundleMeta(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    entry_path: str
    file_count: int
    total_bytes: int
    owner_user_id: int | None
    workspace_slug: str
    created_at: datetime


class BulkDeleteBundlesRequest(BaseModel):
    """부서 임베드 번들 일괄 삭제 — 지울 bundle_id 목록."""

    bundle_ids: list[str] = Field(..., min_length=1)


class ReassignBundlesRequest(BaseModel):
    """부서 임베드 번들 이관 — 대상 부서로 workspace_slug 변경."""

    bundle_ids: list[str] = Field(..., min_length=1)
    target_slug: str = Field(..., min_length=1, max_length=64)
