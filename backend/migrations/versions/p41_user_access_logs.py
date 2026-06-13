"""user_access_logs — 사용자 접속(로그인/가입) 이력 (테이블 추가, 백필 없음).

Revision ID: p41_user_access_logs
Revises: p40_report_default_view_mode
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "p41_user_access_logs"
down_revision: Union[str, None] = "p40_report_default_view_mode"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_access_logs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("email", sa.String(length=255), nullable=False, server_default=""),
        sa.Column(
            "event", sa.String(length=32), nullable=False, server_default="login"
        ),
        sa.Column(
            "success", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
        sa.Column("ip_address", sa.String(length=64), nullable=True),
        sa.Column("user_agent", sa.String(length=512), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        # 계정 삭제 시 이력은 남기고 user_id 만 끊는다.
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_user_access_logs_created", "user_access_logs", ["created_at"]
    )
    op.create_index(
        "ix_user_access_logs_user_created",
        "user_access_logs",
        ["user_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_user_access_logs_user_created", "user_access_logs")
    op.drop_index("ix_user_access_logs_created", "user_access_logs")
    op.drop_table("user_access_logs")
