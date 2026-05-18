"""reports.props_overrides — per-report widget props overrides

Revision ID: 1f1c5b19b95e
Revises: c5a31f80b412
Create Date: 2026-05-15 00:00:00.000000

Adds a `props_overrides` JSONB column to `reports`. The shape is
`{ "<block_id>": { "text_style": {...}, "depth_styles": {...} } }`.
Only a small whitelist of keys is accepted by the service layer — the
column is intentionally untyped at the DB level so the whitelist can
grow without further migrations.

Per-page overrides live inside the existing `pages[]` JSONB blob and
do not require a schema change.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "1f1c5b19b95e"
down_revision: Union[str, None] = "c5a31f80b412"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "reports",
        sa.Column(
            "props_overrides",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("reports", "props_overrides")
