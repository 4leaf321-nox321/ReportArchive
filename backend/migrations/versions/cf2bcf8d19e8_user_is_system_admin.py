"""user is_system_admin

Revision ID: cf2bcf8d19e8
Revises: ff19b84aa109
Create Date: 2026-05-25 06:21:26.337357

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'cf2bcf8d19e8'
down_revision: Union[str, None] = 'ff19b84aa109'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "is_system_admin",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )
    # Bootstrap: the original seed user (id=1, 'admin') becomes the
    # first system admin. All other existing users default to false —
    # system admin can grant the flag to others post-migration.
    # Pre-production assumption: user id=1 exists. The UPDATE is a
    # no-op if it doesn't (e.g. wiped-and-reseeded environment) and
    # an operator can promote whoever they want by SQL.
    op.execute("UPDATE users SET is_system_admin = true WHERE id = 1")


def downgrade() -> None:
    op.drop_column("users", "is_system_admin")
