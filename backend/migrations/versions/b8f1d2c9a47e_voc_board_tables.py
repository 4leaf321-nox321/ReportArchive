"""VOC board tables — posts + comments

Revision ID: b8f1d2c9a47e
Revises: a3e4f9c81d27
Create Date: 2026-05-22 14:00:00.000000

System-wide feedback board. Posts are independent of the workspace
visibility tree — anyone authenticated can read/write — so we don't
mirror reports' workspace ownership pattern. `workspace_slug` is kept
as a triage hint only (which workspace was the user in when posting).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "b8f1d2c9a47e"
down_revision: Union[str, None] = "a3e4f9c81d27"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_CATEGORY_VALUES = ("bug", "feature", "question", "improvement", "other")
_STATUS_VALUES = ("open", "in_progress", "resolved", "wontfix")
_PRIORITY_VALUES = ("low", "normal", "high", "critical")


def upgrade() -> None:
    # Each enum type is used by exactly one column below, so we let
    # the table-create call materialize the type (default
    # create_type=True). Avoids the "type already exists" double-
    # create issue that comes from calling .create() explicitly *and*
    # again implicitly through the column definition.
    op.create_table(
        "voc_posts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "category",
            sa.Enum(*_CATEGORY_VALUES, name="voc_category_enum"),
            nullable=False,
            server_default="question",
        ),
        sa.Column(
            "status",
            sa.Enum(*_STATUS_VALUES, name="voc_status_enum"),
            nullable=False,
            server_default="open",
        ),
        sa.Column(
            "priority",
            sa.Enum(*_PRIORITY_VALUES, name="voc_priority_enum"),
            nullable=False,
            server_default="normal",
        ),
        sa.Column(
            "author_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "workspace_slug",
            sa.String(length=64),
            sa.ForeignKey("workspaces.slug", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("linked_url", sa.String(length=500), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_voc_posts_status", "voc_posts", ["status"])
    op.create_index("ix_voc_posts_category", "voc_posts", ["category"])
    op.create_index("ix_voc_posts_author", "voc_posts", ["author_user_id"])

    op.create_table(
        "voc_comments",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "post_id",
            sa.Integer(),
            sa.ForeignKey("voc_posts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "author_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
    )
    op.create_index("ix_voc_comments_post", "voc_comments", ["post_id"])
    op.create_index("ix_voc_comments_author", "voc_comments", ["author_user_id"])


def downgrade() -> None:
    op.drop_index("ix_voc_comments_author", table_name="voc_comments")
    op.drop_index("ix_voc_comments_post", table_name="voc_comments")
    op.drop_table("voc_comments")
    op.drop_index("ix_voc_posts_author", table_name="voc_posts")
    op.drop_index("ix_voc_posts_category", table_name="voc_posts")
    op.drop_index("ix_voc_posts_status", table_name="voc_posts")
    op.drop_table("voc_posts")
    sa.Enum(name="voc_priority_enum").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="voc_status_enum").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="voc_category_enum").drop(op.get_bind(), checkfirst=True)
