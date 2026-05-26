"""phase 5B — composite_report_items.display_column

Per-item layout hint for the DOCX export. `1` = left column (default),
`2` = right column. Only meaningful when the user exports with the
landscape-2col layout option; portrait/1-col exports ignore this.

Stored on the item itself so the column placement survives across
edits/exports without a separate UI state.

Revision ID: p5b_composite_display_column
Revises: p5a_composite_publish
Create Date: 2026-05-27
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p5b_composite_display_column"
down_revision: Union[str, None] = "p5a_composite_publish"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "composite_report_items",
        sa.Column(
            "display_column",
            sa.Integer(),
            nullable=False,
            server_default="1",
        ),
    )


def downgrade() -> None:
    op.drop_column("composite_report_items", "display_column")
