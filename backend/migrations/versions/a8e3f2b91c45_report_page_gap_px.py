"""report page_gap_px column

Revision ID: a8e3f2b91c45
Revises: f2a8c9d04eb1
Create Date: 2026-05-23 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a8e3f2b91c45"
down_revision: Union[str, None] = "f2a8c9d04eb1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable on purpose — NULL means "fall back to the frontend's default
    # vertical gap between widgets" so existing rows continue to render
    # unchanged. New reports also start NULL and only persist a value once
    # the user explicitly picks one via the 보고서 설정 dialog.
    op.add_column(
        "reports",
        sa.Column("page_gap_px", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("reports", "page_gap_px")
