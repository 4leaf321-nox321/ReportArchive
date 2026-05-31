"""HTML embed bundle metadata.

A *bundle* is a folder of files (main HTML + sub json/js/css/images) kept
on disk under {settings.embed_bundles_dir_path}/{id}/<relpath...>. The
report block stores only the opaque `id` (capability) + `entry_path`; the
files themselves are served by GET /api/embed/{id}/{relpath} with no auth
(possession of the unguessable id == access — see HTML임베드_번들_설계.md §4).
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class HtmlEmbedBundle(Base):
    __tablename__ = "html_embed_bundles"
    __table_args__ = (
        Index("ix_embed_bundles_owner", "owner_user_id"),
        Index("ix_embed_bundles_workspace", "workspace_slug"),
    )

    # 32-char hex (uuid4().hex). Public capability — embedded in report
    # content as bundle_id and used in the serving URL.
    id: Mapped[str] = mapped_column(String(32), primary_key=True)

    # Entry (main) HTML — posix relpath within the bundle, e.g. "index.html"
    # or "report/index.html". The iframe loads /api/embed/{id}/{entry_path}.
    entry_path: Mapped[str] = mapped_column(String(512), nullable=False)

    file_count: Mapped[int] = mapped_column(Integer, nullable=False)
    total_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)

    owner_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    workspace_slug: Mapped[str] = mapped_column(
        ForeignKey("workspaces.slug", ondelete="RESTRICT"), nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
