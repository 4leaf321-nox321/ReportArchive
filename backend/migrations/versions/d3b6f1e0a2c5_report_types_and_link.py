"""Report types vocabulary + reports.report_type_id link

Revision ID: d3b6f1e0a2c5
Revises: c2a4e7b18d09
Create Date: 2026-05-22 18:00:00.000000

System-wide controlled vocabulary for tagging the *purpose* of a
report (separate from the template, which defines shape). Users can
propose new entries from the report-settings dialog — those land as
`unofficial`; admins promote them to `official` from the admin tab.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d3b6f1e0a2c5"
down_revision: Union[str, None] = "c2a4e7b18d09"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_STATUS_VALUES = ("official", "unofficial")


def upgrade() -> None:
    op.create_table(
        "report_types",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "status",
            sa.Enum(*_STATUS_VALUES, name="report_type_status_enum"),
            nullable=False,
            server_default="unofficial",
        ),
        sa.Column(
            "created_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "approved_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
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
        sa.Column("approved_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_report_types_status", "report_types", ["status"])
    op.create_index(
        "ix_report_types_created_by", "report_types", ["created_by_user_id"]
    )
    op.create_index(
        "uq_report_types_name", "report_types", ["name"], unique=True
    )

    op.add_column(
        "reports",
        sa.Column(
            "report_type_id",
            sa.Integer(),
            sa.ForeignKey("report_types.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_reports_report_type_id", "reports", ["report_type_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_reports_report_type_id", table_name="reports")
    op.drop_column("reports", "report_type_id")
    op.drop_index("uq_report_types_name", table_name="report_types")
    op.drop_index("ix_report_types_created_by", table_name="report_types")
    op.drop_index("ix_report_types_status", table_name="report_types")
    op.drop_table("report_types")
    sa.Enum(name="report_type_status_enum").drop(op.get_bind(), checkfirst=True)
