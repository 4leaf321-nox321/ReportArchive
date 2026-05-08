"""Pydantic schemas for files."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class FileMeta(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    filename: str
    mime_type: str
    size: int
    is_image: bool
    owner_user_id: int | None
    workspace_slug: str
    uploaded_at: datetime
