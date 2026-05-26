"""phase 3 — editor activity types + report attribution columns

Adds:
  - ReportActivityType enum values 'editor_added', 'editor_removed'
    so add/remove editor grants leave an audit trail in the timeline.
  - Reports.last_edited_by_user_id, last_edited_at — denormalized
    "마지막 수정자" for listing UIs ("박과장 · 김부장 수정") without
    joining the activity log on every list query.

NotificationType already carries `report_edited_by_other` and
`editor_added` (Phase 0 was generous), so no notification migration
needed.

Revision ID: 4c1e9b2d0871
Revises: f943a72fe3ad
Create Date: 2026-05-25
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "4c1e9b2d0871"
down_revision: Union[str, None] = "f943a72fe3ad"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── activity enum: 2 new values ─────────────────────────────────
    # ALTER TYPE ... ADD VALUE can't run inside a transaction in some
    # PG versions; alembic's transactional-DDL guard usually handles
    # this, but we explicitly COMMIT first to be safe.
    op.execute("COMMIT")
    op.execute(
        "ALTER TYPE report_activity_type_enum ADD VALUE IF NOT EXISTS 'editor_added'"
    )
    op.execute(
        "ALTER TYPE report_activity_type_enum ADD VALUE IF NOT EXISTS 'editor_removed'"
    )

    # ── reports: attribution columns ────────────────────────────────
    op.add_column(
        "reports",
        sa.Column("last_edited_by_user_id", sa.Integer(), nullable=True),
    )
    op.add_column(
        "reports",
        sa.Column("last_edited_at", sa.DateTime(), nullable=True),
    )
    op.create_foreign_key(
        "fk_reports_last_edited_by",
        "reports",
        "users",
        ["last_edited_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_reports_last_edited_by",
        "reports",
        ["last_edited_by_user_id"],
        unique=False,
    )
    # Backfill: copy existing `updated_by_user_id`/`updated_at` into
    # the new columns so listings have data on day one. Phase 2 already
    # populated those on every save; we just need to mirror them.
    op.execute(
        """
        UPDATE reports
           SET last_edited_by_user_id = updated_by_user_id,
               last_edited_at         = updated_at
         WHERE last_edited_by_user_id IS NULL
        """
    )


def downgrade() -> None:
    op.drop_index("ix_reports_last_edited_by", table_name="reports")
    op.drop_constraint(
        "fk_reports_last_edited_by", "reports", type_="foreignkey"
    )
    op.drop_column("reports", "last_edited_at")
    op.drop_column("reports", "last_edited_by_user_id")
    # PG can't remove enum values cleanly without recreating the type;
    # for dev we accept the orphan values. They have no impact on
    # behavior since no rows of those types remain after the column
    # drops above.
