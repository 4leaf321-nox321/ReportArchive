"""workspace_pinned_reports — 부서 홈 고정 보고서(핀).

Revision ID: p43_workspace_pinned_reports
Revises: p42_template_metrics
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "p43_workspace_pinned_reports"
down_revision: Union[str, None] = "p42_template_metrics"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "workspace_pinned_reports",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("workspace_slug", sa.String(length=64), nullable=False),
        sa.Column("report_id", sa.Integer(), nullable=False),
        sa.Column("pinned_by_user_id", sa.Integer(), nullable=True),
        sa.Column(
            "display_order", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["workspace_slug"], ["workspaces.slug"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["report_id"], ["reports.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["pinned_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "workspace_slug", "report_id", name="uq_workspace_pinned_report"
        ),
    )
    op.create_index(
        "ix_workspace_pins_ws_order",
        "workspace_pinned_reports",
        ["workspace_slug", "display_order"],
    )


def downgrade() -> None:
    op.drop_index("ix_workspace_pins_ws_order", "workspace_pinned_reports")
    op.drop_table("workspace_pinned_reports")
