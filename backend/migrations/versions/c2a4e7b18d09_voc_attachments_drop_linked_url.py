"""voc: drop linked_url, add attachments

Revision ID: c2a4e7b18d09
Revises: b8f1d2c9a47e
Create Date: 2026-05-22 16:00:00.000000

UX shift: instead of asking the user to copy a URL into a free-text
"관련 페이지" field, they upload screenshots (or any image) directly
into the post. The post now references uploaded files via JSONB list
of {file_id, filename, size, mime_type} — same contract image/
attachment widgets use.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "c2a4e7b18d09"
down_revision: Union[str, None] = "b8f1d2c9a47e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_column("voc_posts", "linked_url")
    op.add_column(
        "voc_posts",
        sa.Column(
            "attachments",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("voc_posts", "attachments")
    op.add_column(
        "voc_posts",
        sa.Column("linked_url", sa.String(length=500), nullable=True),
    )
