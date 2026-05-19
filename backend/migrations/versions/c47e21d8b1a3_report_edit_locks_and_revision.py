"""report edit locks and revision

Revision ID: c47e21d8b1a3
Revises: 8c1f23a405e1
Create Date: 2026-05-19 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c47e21d8b1a3"
down_revision: Union[str, None] = "8c1f23a405e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Optimistic-concurrency counter. Every successful update_report() bumps
    # this; PATCH callers must echo back the value they fetched, otherwise
    # the service raises a revision_mismatch 409.
    op.add_column(
        "reports",
        sa.Column(
            "revision",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("1"),
        ),
    )

    # Pessimistic edit-lock table. One row per locked report. PK = report_id
    # so DB-level uniqueness handles the "only one active editor" invariant.
    # `expires_at` carries the lease deadline; acquire_lock() upserts a fresh
    # row whenever the existing one is past it, so we don't need a janitor.
    op.create_table(
        "report_edit_locks",
        sa.Column("report_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("acquired_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["report_id"], ["reports.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("report_id"),
    )
    op.create_index(
        "ix_report_edit_locks_user_id",
        "report_edit_locks",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_report_edit_locks_user_id", table_name="report_edit_locks"
    )
    op.drop_table("report_edit_locks")
    op.drop_column("reports", "revision")
