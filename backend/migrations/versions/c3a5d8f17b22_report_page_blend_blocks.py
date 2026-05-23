"""report page_blend_blocks column

Revision ID: c3a5d8f17b22
Revises: b91c4d572e08
Create Date: 2026-05-23 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c3a5d8f17b22"
down_revision: Union[str, None] = "b91c4d572e08"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable + treated as False when null on the frontend. Existing rows
    # render unchanged (bordered cards); new reports stay null until the
    # user explicitly toggles the 보고서 설정 → 페이지 → 컨테이너 경계
    # blending option.
    op.add_column(
        "reports",
        sa.Column("page_blend_blocks", sa.Boolean(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("reports", "page_blend_blocks")
