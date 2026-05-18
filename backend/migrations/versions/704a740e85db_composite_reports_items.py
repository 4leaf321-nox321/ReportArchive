"""composite reports + items

Revision ID: 704a740e85db
Revises: 4f70ea1a34a8
Create Date: 2026-05-18 19:17:19.266572

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '704a740e85db'
down_revision: Union[str, None] = '4f70ea1a34a8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "composite_reports",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "workspace_slug",
            sa.String(length=64),
            sa.ForeignKey("workspaces.slug", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column(
            "kind",
            # Let Alembic auto-create the enum type when the table is built —
            # explicit op.execute("CREATE TYPE …") + create_type=False was
            # racing with SQLAlchemy's own bookkeeping inside the migration
            # txn and leaving the type half-created on retries.
            sa.Enum("recurring", "theme", name="composite_kind_enum"),
            nullable=False,
        ),
        # For recurring composites this is the period the digest covers
        # (week/month). For theme composites it stays NULL.
        sa.Column("period_date", sa.Date(), nullable=True),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "owner_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "updated_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("ix_composite_reports_workspace", "composite_reports", ["workspace_slug"])
    op.create_index("ix_composite_reports_kind", "composite_reports", ["kind"])
    op.create_index("ix_composite_reports_period_date", "composite_reports", ["period_date"])

    op.create_table(
        "composite_report_items",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "composite_id",
            sa.Integer(),
            sa.ForeignKey("composite_reports.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
        # Exactly one of these is non-null — enforced by a CHECK constraint
        # so polymorphism stays tractable without a generic JSONB ref.
        sa.Column(
            "ref_report_id",
            sa.Integer(),
            sa.ForeignKey("reports.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "ref_composite_id",
            sa.Integer(),
            sa.ForeignKey("composite_reports.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.CheckConstraint(
            "(ref_report_id IS NOT NULL)::int + (ref_composite_id IS NOT NULL)::int = 1",
            name="ck_composite_item_exactly_one_ref",
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index("ix_composite_items_composite", "composite_report_items", ["composite_id"])
    op.create_index("ix_composite_items_report", "composite_report_items", ["ref_report_id"])
    op.create_index("ix_composite_items_subcomposite", "composite_report_items", ["ref_composite_id"])


def downgrade() -> None:
    op.drop_index("ix_composite_items_subcomposite", table_name="composite_report_items")
    op.drop_index("ix_composite_items_report", table_name="composite_report_items")
    op.drop_index("ix_composite_items_composite", table_name="composite_report_items")
    op.drop_table("composite_report_items")
    op.drop_index("ix_composite_reports_period_date", table_name="composite_reports")
    op.drop_index("ix_composite_reports_kind", table_name="composite_reports")
    op.drop_index("ix_composite_reports_workspace", table_name="composite_reports")
    op.drop_table("composite_reports")
    op.execute("DROP TYPE composite_kind_enum")
