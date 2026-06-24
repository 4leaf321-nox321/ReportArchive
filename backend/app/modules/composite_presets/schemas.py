"""Pydantic schemas for composite presets (종합보고 양식)."""
from __future__ import annotations

from datetime import date as date_type
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.modules.composites.models import CompositeKind


class CompositePresetCreate(BaseModel):
    """Snapshot an existing composite into a reusable starting form."""

    source_composite_id: int
    name: str = Field(..., min_length=1, max_length=255)
    description: str = ""
    # NULL/omitted or empty = 전사(global). Each slug = a workspace the
    # preset is scoped to (visible to its tree). Validated in the service.
    owner_workspace_slugs: Optional[list[str]] = None
    # Full ordered group skeleton from the client draft, INCLUDING empty
    # groups that have no items yet (those live only in the frontend's
    # `pendingGroups` and never reach the DB). When omitted, the service
    # derives groups from the source composite's saved items instead.
    groups: list[str] = []


class CompositePresetInstantiate(BaseModel):
    """Create a new composite seeded from a preset. Carries the per-회차
    values the preset can't know (where it lives, its title, the period)."""

    workspace_slug: str = Field(..., min_length=1, max_length=64)
    title: str = Field(..., min_length=1, max_length=255)
    kind: CompositeKind
    period_date: Optional[date_type] = None


class CompositePresetUpdate(BaseModel):
    """Edit a preset's 메타정보 + 그룹 목록 (관리 탭). 요약 위젯은 여기서
    못 고친다 — 종합보고 에디터에서 다시 저장해야 한다. exclude_unset 으로
    보낸 필드만 반영하므로 owner_workspace_slugs=null 은 '전사로 변경'을 뜻
    한다(키를 안 보내면 '변경 안 함')."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = None
    owner_workspace_slugs: Optional[list[str]] = None
    groups: Optional[list[str]] = None


class CompositePresetArchiveUpdate(BaseModel):
    """보관(True) / 보관해제(False) 토글."""

    archived: bool


class CompositePresetSummary(BaseModel):
    """List-view projection — drops the heavy summary_widgets blob but keeps
    the (small) group skeleton so the 관리 탭 편집 다이얼로그가 별도 fetch 없이
    프리필할 수 있다."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str
    source_kind: Optional[str] = None
    owner_workspace_slugs: Optional[list[str]] = None
    groups: list[str] = []
    summary_widget_count: int = 0
    created_by_user_id: Optional[int] = None
    created_by_name: Optional[str] = None
    archived_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, obj: Any) -> Any:
        if obj is None or isinstance(obj, dict):
            return obj
        out = {
            k: getattr(obj, k)
            for k in (
                "id", "name", "description", "source_kind",
                "owner_workspace_slugs", "created_by_user_id",
                "archived_at", "created_at", "updated_at",
            )
            if hasattr(obj, k)
        }
        seed = getattr(obj, "seed", None) or {}
        out["groups"] = list(seed.get("groups") or [])
        out["summary_widget_count"] = len(seed.get("summary_widgets") or [])
        creator = getattr(obj, "created_by", None)
        if creator is not None:
            out["created_by_name"] = creator.name
        return out
