"""Pydantic schemas for report presets (시작 양식)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


class PresetCreate(BaseModel):
    """Snapshot an existing report into a reusable starting form."""

    source_report_id: int
    name: str = Field(..., min_length=1, max_length=255)
    description: str = ""
    # NULL/omitted or empty = 전사(global). Each slug = a workspace the
    # preset is scoped to (visible to its tree). Validated in the service.
    owner_workspace_slugs: Optional[list[str]] = None


class PresetInstantiate(BaseModel):
    """Create a new report seeded from a preset."""

    # Optional — defaults to the preset name on the server when omitted.
    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    folder_id: Optional[int] = None


class PresetUpdate(BaseModel):
    """메타정보만 수정(이름·설명·공개범위). 내용(seed)은 update-from-report 로
    별도 갱신한다. 보낸 필드만 반영 — owner_workspace_slugs 는 명시적 null/[] 이면
    전사(global)로, 생략하면 그대로 둔다(model_fields_set 으로 구분)."""

    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = None
    owner_workspace_slugs: Optional[list[str]] = None


class PresetUpdateFromReport(BaseModel):
    """양식 내용(seed) + 템플릿 바인딩을 이 보고서로 덮어쓴다(양식 편집 세션의
    '양식에 반영')."""

    source_report_id: int


class PresetSummary(BaseModel):
    """List-view projection — drops the heavy `seed` blob."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str
    template_id: str
    template_version: int
    owner_workspace_slugs: Optional[list[str]] = None
    created_by_user_id: Optional[int] = None
    created_by_name: Optional[str] = None
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
                "id", "name", "description", "template_id", "template_version",
                "owner_workspace_slugs", "created_by_user_id",
                "created_at", "updated_at",
            )
            if hasattr(obj, k)
        }
        creator = getattr(obj, "created_by", None)
        if creator is not None:
            out["created_by_name"] = creator.name
        return out


class PresetInstantiateResult(BaseModel):
    """Slim result of creating a report from a preset — enough to navigate."""

    id: int
    workspace_slug: str
