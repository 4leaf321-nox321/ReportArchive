"""Pydantic schemas for the mounts module."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.mounts.models import MountEditPolicy


class MountRead(BaseModel):
    """One mount link — a report visible on one org workspace."""

    model_config = ConfigDict(from_attributes=True)

    report_id: int
    workspace_slug: str
    edit_policy: MountEditPolicy
    mounted_by_user_id: Optional[int] = None
    mounted_at: datetime
    note: str
    # Org folder placement on this board. NULL = 미분류 in that board's
    # listing. Same Report can be in different folders on different
    # boards (folder is mount-level, not report-level).
    folder_id: Optional[int] = None


class MountListResponse(BaseModel):
    items: list[MountRead]


class MountCreate(BaseModel):
    """POST /api/mounts payload — promote a report to one or more org
    boards in a single request.

    `edit_policy`, `note`, and `folder_id` are uniform across all targets
    here. Per-board variation (different folder per board) is two
    separate POST calls. `folder_id` is interpreted in the context of
    each target workspace — caller is responsible for picking a folder
    that lives in that workspace.
    """

    report_id: int
    workspace_slugs: list[str] = Field(..., min_length=1)
    edit_policy: MountEditPolicy = MountEditPolicy.default
    note: str = ""
    folder_id: Optional[int] = None


class MountFolderUpdate(BaseModel):
    """PUT /api/mounts/{report_id}/{workspace_slug}/folder payload —
    metadata-only move of an existing mount between org folders.
    """

    folder_id: Optional[int] = None


class MountEditPolicyUpdate(BaseModel):
    """PUT /api/mounts/{report_id}/{workspace_slug}/edit-policy payload —
    change the per-board edit policy (Phase 3). Owner-only.
    """

    edit_policy: MountEditPolicy


class UnmountResponse(BaseModel):
    """Acknowledgement for DELETE /api/mounts/{report_id}/{workspace_slug}."""

    report_id: int
    workspace_slug: str
