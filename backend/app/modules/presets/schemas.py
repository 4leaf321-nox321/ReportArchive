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
