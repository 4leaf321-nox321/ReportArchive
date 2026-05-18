"""drop report period column

Revision ID: e0e154b0214e
Revises: e18e0d43a9a6
Create Date: 2026-05-18 17:33:17.678839

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e0e154b0214e'
down_revision: Union[str, None] = 'e18e0d43a9a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Free-form text column never populated by any UI; report_date now
    # covers the "what reporting period is this for?" question.
    op.drop_column("reports", "period")


def downgrade() -> None:
    op.add_column(
        "reports",
        sa.Column("period", sa.String(length=32), nullable=False, server_default=""),
    )
    op.alter_column("reports", "period", server_default=None)
