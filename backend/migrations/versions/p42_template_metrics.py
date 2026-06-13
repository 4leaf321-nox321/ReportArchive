"""template_metrics — 대시보드 수치 지표 정의 (테이블 추가, 백필 없음).

Revision ID: p42_template_metrics
Revises: p41_user_access_logs
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "p42_template_metrics"
down_revision: Union[str, None] = "p41_user_access_logs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "template_metrics",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("template_id", sa.String(length=64), nullable=False),
        sa.Column("block_id", sa.String(length=64), nullable=False),
        sa.Column("field_key", sa.String(length=64), nullable=True),
        sa.Column(
            "source_kind",
            sa.String(length=32),
            nullable=False,
            server_default="key_value",
        ),
        sa.Column("agg", sa.String(length=16), nullable=False, server_default="avg"),
        sa.Column("label", sa.String(length=128), nullable=False, server_default=""),
        sa.Column("unit", sa.String(length=32), nullable=False, server_default=""),
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
        sa.Column(
            "display_order", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "template_id", "block_id", "field_key", name="uq_template_metric"
        ),
    )
    op.create_index(
        "ix_template_metrics_template", "template_metrics", ["template_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_template_metrics_template", "template_metrics")
    op.drop_table("template_metrics")
