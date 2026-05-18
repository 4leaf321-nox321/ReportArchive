"""report_date column

Revision ID: e18e0d43a9a6
Revises: 4b5fea6acfdd
Create Date: 2026-05-18 17:20:19.654711

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e18e0d43a9a6'
down_revision: Union[str, None] = '4b5fea6acfdd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add nullable first so existing rows survive, backfill from created_at::date,
    # then lock to NOT NULL with a default so future inserts get today() automatically.
    op.add_column("reports", sa.Column("report_date", sa.Date(), nullable=True))
    op.execute("UPDATE reports SET report_date = created_at::date WHERE report_date IS NULL")
    op.alter_column("reports", "report_date", nullable=False, server_default=sa.text("CURRENT_DATE"))
    op.create_index("ix_reports_report_date", "reports", ["report_date"])


def downgrade() -> None:
    op.drop_index("ix_reports_report_date", table_name="reports")
    op.drop_column("reports", "report_date")
