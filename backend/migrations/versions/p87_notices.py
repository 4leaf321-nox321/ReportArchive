"""notices: create notice_posts table

Revision ID: p87_notices
Revises: p86_saved_search_notif
Create Date: 2026-07-17 00:00:00.000000

System-wide announcement board. Only system admins post; everyone reads.
Mirror of VOC but simpler — title / body / image attachments + a pinned
flag, no categories / status / priority / comments.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "p87_notices"
down_revision: Union[str, None] = "p86_saved_search_notif"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "notice_posts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "pinned",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "author_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "attachments",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_notice_posts_pinned", "notice_posts", ["pinned"])
    op.create_index("ix_notice_posts_author", "notice_posts", ["author_user_id"])


def downgrade() -> None:
    op.drop_index("ix_notice_posts_author", table_name="notice_posts")
    op.drop_index("ix_notice_posts_pinned", table_name="notice_posts")
    op.drop_table("notice_posts")
