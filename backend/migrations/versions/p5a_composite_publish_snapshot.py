"""phase 5A — composite publish + snapshot freeze columns

Adds:
  - CompositeReport.published_at / published_by_user_id — tracks the
    발행 transition for recurring composites. NULL = unpublished
    (draft), datetime = publish moment. theme composites never publish
    (they're always live), so these stay NULL for them.

The snapshot itself lives in CompositeReportItem.snapshot_content
(already added in Phase 0), but only Phase 5A wires the publish/
unpublish actions that fill / clear it.

Revision ID: p5a_composite_publish
Revises: 4c1e9b2d0871
Create Date: 2026-05-26
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p5a_composite_publish"
down_revision: Union[str, None] = "4c1e9b2d0871"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "composite_reports",
        sa.Column("published_at", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "composite_reports",
        sa.Column("published_by_user_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_composite_reports_published_by",
        "composite_reports",
        "users",
        ["published_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_composite_reports_published_at",
        "composite_reports",
        ["published_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_composite_reports_published_at", table_name="composite_reports"
    )
    op.drop_constraint(
        "fk_composite_reports_published_by",
        "composite_reports",
        type_="foreignkey",
    )
    op.drop_column("composite_reports", "published_by_user_id")
    op.drop_column("composite_reports", "published_at")
