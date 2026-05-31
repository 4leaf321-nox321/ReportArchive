"""HTML embed bundle schemas."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class BundleMeta(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    entry_path: str
    file_count: int
    total_bytes: int
    owner_user_id: int | None
    workspace_slug: str
    created_at: datetime
