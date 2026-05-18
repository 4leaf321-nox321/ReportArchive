"""report updated_by_user_id

Revision ID: 4b5fea6acfdd
Revises: 1f1c5b19b95e
Create Date: 2026-05-18 16:49:15.858504

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4b5fea6acfdd'
down_revision: Union[str, None] = '1f1c5b19b95e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "reports",
        sa.Column("updated_by_user_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_reports_updated_by_user",
        "reports",
        "users",
        ["updated_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_reports_updated_by_user_id",
        "reports",
        ["updated_by_user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_reports_updated_by_user_id", table_name="reports")
    op.drop_constraint("fk_reports_updated_by_user", "reports", type_="foreignkey")
    op.drop_column("reports", "updated_by_user_id")
