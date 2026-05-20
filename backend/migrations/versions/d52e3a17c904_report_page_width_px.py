"""report page_width_px column

Revision ID: d52e3a17c904
Revises: c47e21d8b1a3
Create Date: 2026-05-20 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "d52e3a17c904"
down_revision: Union[str, None] = "c47e21d8b1a3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable on purpose — NULL means "fall back to the frontend's narrow
    # default" so existing rows continue to render unchanged. New reports
    # also start NULL and only persist a value once the user explicitly
    # picks one via the report's right-click "보고서 폭 설정" dialog.
    op.add_column(
        "reports",
        sa.Column("page_width_px", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("reports", "page_width_px")
