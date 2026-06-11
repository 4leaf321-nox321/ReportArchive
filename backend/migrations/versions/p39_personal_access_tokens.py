"""personal_access_tokens — MCP 등 외부 클라이언트용 개인 토큰 (테이블 추가, 백필 없음).

Revision ID: p39_personal_access_tokens
Revises: p38_report_versions
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "p39_personal_access_tokens"
down_revision: Union[str, None] = "p38_report_versions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "personal_access_tokens",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("token_prefix", sa.String(length=16), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_personal_access_tokens_user_id", "personal_access_tokens", ["user_id"]
    )
    op.create_index(
        "ix_personal_access_tokens_token_hash",
        "personal_access_tokens",
        ["token_hash"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_personal_access_tokens_token_hash", "personal_access_tokens")
    op.drop_index("ix_personal_access_tokens_user_id", "personal_access_tokens")
    op.drop_table("personal_access_tokens")
