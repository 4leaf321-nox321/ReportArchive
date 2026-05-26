"""Pydantic schemas for AI prompts."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.modules.prompts.models import PromptStatus
from app.modules.prompts.rendering import detect_widget_coverage


class _UserMini(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: str


class PromptRead(BaseModel):
    """Full prompt row + derived widget-coverage fields. The derived
    fields are computed server-side from `body` so the picker can render
    coverage chips without re-running the regex on every keystroke."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str
    body: str
    status: PromptStatus
    settings: dict[str, Any] = {}
    created_by: Optional[_UserMini] = None
    approved_by: Optional[_UserMini] = None
    created_at: datetime
    updated_at: datetime
    approved_at: Optional[datetime] = None

    # Derived from `body` via rendering.detect_widget_coverage. Stay in
    # sync with the body automatically because the model_validator below
    # populates them after Pydantic has filled the rest of the fields.
    derived_widget_types: list[str] = []
    wildcard_all: bool = False
    # True iff body uses {{template_blocks}} — marks the prompt as a
    # "current page editor" (patch-style flow) rather than a wildcard or
    # per-widget generator. Mutually exclusive with the chip kinds but
    # technically can coexist if an author wants both contexts.
    page_context: bool = False

    @model_validator(mode="after")
    def _compute_coverage(self) -> "PromptRead":
        coverage = detect_widget_coverage(self.body or "")
        # Use object.__setattr__ because Pydantic v2 freezes fields by
        # default during validation; we're intentionally amending the
        # output after the rest is built.
        object.__setattr__(self, "derived_widget_types", coverage["widget_types"])
        object.__setattr__(self, "wildcard_all", coverage["wildcard_all"])
        object.__setattr__(self, "page_context", coverage["page_context"])
        return self


class PromptCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    description: str = Field(default="", max_length=2000)
    body: str = Field(default="", max_length=200_000)
    settings: dict[str, Any] = Field(default_factory=dict)
    # Admin-only — if set to "official" by a non-admin, the route layer
    # downgrades it to unofficial. Default is None which means "let the
    # service pick the right status for the caller's role".
    status: Optional[PromptStatus] = None


class PromptUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=128)
    description: Optional[str] = Field(default=None, max_length=2000)
    body: Optional[str] = Field(default=None, max_length=200_000)
    settings: Optional[dict[str, Any]] = None


class PromptListResponse(BaseModel):
    items: list[PromptRead]
