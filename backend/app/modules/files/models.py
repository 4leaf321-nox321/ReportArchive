"""File metadata model — backs the `image` and `attachment` widgets.

The actual bytes live on disk under settings.upload_dir_path. This row
holds the metadata + ownership trail. file_id is a UUID string referenced
from `reports.content` (e.g., {"files": [{"file_id": "...", ...}]}).
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class File(Base):
    __tablename__ = "files"
    __table_args__ = (
        Index("ix_files_owner", "owner_user_id"),
        Index("ix_files_workspace", "workspace_slug"),
    )

    # 36-char UUID string. Public — used in report content as file_id.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)

    # Original filename as uploaded (display only — never used for disk paths).
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(128), nullable=False)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)

    # Path on disk relative to settings.upload_dir_path.
    storage_path: Mapped[str] = mapped_column(String(255), nullable=False)

    owner_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    workspace_slug: Mapped[str] = mapped_column(
        ForeignKey("workspaces.slug", ondelete="RESTRICT"), nullable=False
    )

    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    @property
    def is_image(self) -> bool:
        return self.mime_type.startswith("image/")
