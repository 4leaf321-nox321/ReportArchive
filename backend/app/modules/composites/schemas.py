"""Pydantic schemas for composite reports."""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.modules.composites.models import CompositeKind


def _flatten_user_refs(obj: Any) -> Any:
    """Pull joined user info into flat name/email fields so the frontend
    doesn't need a separate /api/users lookup per row. Mirrors the helper
    used by the reports schemas."""
    if obj is None or isinstance(obj, dict):
        return obj
    extras: dict[str, Any] = {}
    owner = getattr(obj, "owner", None)
    if owner is not None:
        extras["owner_name"] = owner.name
        extras["owner_email"] = owner.email
    updated_by = getattr(obj, "updated_by", None)
    if updated_by is not None:
        extras["updated_by_name"] = updated_by.name
        extras["updated_by_email"] = updated_by.email
    if not extras:
        return obj
    base: dict[str, Any] = {
        key: getattr(obj, key)
        for key in (
            "id", "workspace_slug", "title", "kind", "period_date",
            "description", "owner_user_id", "updated_by_user_id",
            "items", "created_at", "updated_at",
        )
        if hasattr(obj, key)
    }
    base.update(extras)
    return base


class ItemRefReport(BaseModel):
    """Read-side projection of a referenced source report. Keeps fields
    light so the picker dialog and the detail view both stay snappy."""

    model_config = ConfigDict(extra="ignore", from_attributes=True)

    id: int
    workspace_slug: str
    title: str
    template_id: str
    template_version: int
    report_date: Optional[date] = None
    status: Optional[str] = None
    owner_user_id: Optional[int] = None
    owner_name: Optional[str] = None
    updated_at: Optional[datetime] = None

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, obj: Any) -> Any:
        if obj is None or isinstance(obj, dict):
            return obj
        out: dict[str, Any] = {
            k: getattr(obj, k)
            for k in (
                "id", "workspace_slug", "title", "template_id",
                "template_version", "report_date", "status",
                "owner_user_id", "updated_at",
            )
            if hasattr(obj, k)
        }
        owner = getattr(obj, "owner", None)
        if owner is not None:
            out["owner_name"] = owner.name
        return out


class ItemRefComposite(BaseModel):
    """Read-side projection of a referenced sub-composite (recursive)."""

    model_config = ConfigDict(extra="ignore", from_attributes=True)

    id: int
    workspace_slug: str
    title: str
    kind: CompositeKind
    period_date: Optional[date] = None
    owner_user_id: Optional[int] = None
    owner_name: Optional[str] = None
    updated_at: Optional[datetime] = None

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, obj: Any) -> Any:
        if obj is None or isinstance(obj, dict):
            return obj
        out: dict[str, Any] = {
            k: getattr(obj, k)
            for k in (
                "id", "workspace_slug", "title", "kind", "period_date",
                "owner_user_id", "updated_at",
            )
            if hasattr(obj, k)
        }
        owner = getattr(obj, "owner", None)
        if owner is not None:
            out["owner_name"] = owner.name
        return out


class CompositeItemRead(BaseModel):
    """One entry in a composite report. Either ref_report or ref_composite
    is populated; the frontend uses item_type to decide which to render."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    position: int
    note: str
    item_type: str   # 'report' | 'composite' — convenience for the FE
    ref_report: Optional[ItemRefReport] = None
    ref_composite: Optional[ItemRefComposite] = None

    @model_validator(mode="before")
    @classmethod
    def _decorate(cls, obj: Any) -> Any:
        if obj is None or isinstance(obj, dict):
            return obj
        is_report = getattr(obj, "ref_report_id", None) is not None
        out = {
            "id": getattr(obj, "id"),
            "position": getattr(obj, "position"),
            "note": getattr(obj, "note", ""),
            "item_type": "report" if is_report else "composite",
            "ref_report": getattr(obj, "ref_report", None) if is_report else None,
            "ref_composite": getattr(obj, "ref_composite", None) if not is_report else None,
        }
        return out


class CompositeReportRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    workspace_slug: str
    title: str
    kind: CompositeKind
    period_date: Optional[date] = None
    description: str
    owner_user_id: Optional[int] = None
    owner_name: Optional[str] = None
    owner_email: Optional[str] = None
    updated_by_user_id: Optional[int] = None
    updated_by_name: Optional[str] = None
    updated_by_email: Optional[str] = None
    items: list[CompositeItemRead] = []
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, obj: Any) -> Any:
        return _flatten_user_refs(obj)


class CompositeReportSummary(BaseModel):
    """List-view projection. Drops items + description for bulk responses."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    workspace_slug: str
    title: str
    kind: CompositeKind
    period_date: Optional[date] = None
    owner_user_id: Optional[int] = None
    owner_name: Optional[str] = None
    owner_email: Optional[str] = None
    updated_by_user_id: Optional[int] = None
    updated_by_name: Optional[str] = None
    updated_by_email: Optional[str] = None
    item_count: int = 0
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, obj: Any) -> Any:
        flat = _flatten_user_refs(obj)
        if isinstance(flat, dict):
            items = flat.get("items") or []
            flat["item_count"] = len(items)
            flat.pop("items", None)
        elif hasattr(obj, "items"):
            return {
                **(flat if isinstance(flat, dict) else {}),
                "item_count": len(obj.items or []),
            }
        return flat


# ── Mutations ───────────────────────────────────────────────────────────
class CompositeItemPayload(BaseModel):
    """Request side of an item — caller supplies one of the two refs."""

    note: str = ""
    ref_report_id: Optional[int] = None
    ref_composite_id: Optional[int] = None

    @model_validator(mode="after")
    def _exactly_one(self) -> "CompositeItemPayload":
        ref_count = (self.ref_report_id is not None) + (self.ref_composite_id is not None)
        if ref_count != 1:
            raise ValueError("item must reference exactly one of ref_report_id / ref_composite_id")
        return self


class CompositeReportCreate(BaseModel):
    workspace_slug: str = Field(..., min_length=1, max_length=64)
    title: str = Field(..., min_length=1, max_length=255)
    kind: CompositeKind
    period_date: Optional[date] = None
    description: str = ""
    # Optional initial items — equivalent to creating then PATCHing.
    items: list[CompositeItemPayload] = []


class CompositeReportUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    kind: Optional[CompositeKind] = None
    period_date: Optional[date] = None
    description: Optional[str] = None
    # When set, replaces the entire items list (matching position order).
    # Omit to leave items untouched.
    items: Optional[list[CompositeItemPayload]] = None
