"""report status enum draft in_progress completed

Revision ID: 4f70ea1a34a8
Revises: e0e154b0214e
Create Date: 2026-05-18 17:43:36.367241

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4f70ea1a34a8'
down_revision: Union[str, None] = 'e0e154b0214e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Postgres can't drop / rename enum values in place, so go via TEXT:
    # 1) detach the column from the enum type
    # 2) remap legacy values (in_review/approved -> in_progress, archived -> completed)
    # 3) replace the enum type with the new value set
    # 4) re-attach the column with a cast + restore the draft default
    op.execute("ALTER TABLE reports ALTER COLUMN status DROP DEFAULT")
    op.execute("ALTER TABLE reports ALTER COLUMN status TYPE TEXT")
    op.execute("""
        UPDATE reports
        SET status = CASE
            WHEN status IN ('in_review', 'approved') THEN 'in_progress'
            WHEN status = 'archived' THEN 'completed'
            ELSE status
        END
    """)
    op.execute("DROP TYPE report_status_enum")
    op.execute(
        "CREATE TYPE report_status_enum AS ENUM ('draft', 'in_progress', 'completed')"
    )
    op.execute(
        "ALTER TABLE reports ALTER COLUMN status TYPE report_status_enum "
        "USING status::report_status_enum"
    )
    op.execute("ALTER TABLE reports ALTER COLUMN status SET DEFAULT 'draft'")


def downgrade() -> None:
    op.execute("ALTER TABLE reports ALTER COLUMN status DROP DEFAULT")
    op.execute("ALTER TABLE reports ALTER COLUMN status TYPE TEXT")
    # Best-effort reverse: in_progress -> in_review, completed -> archived.
    op.execute("""
        UPDATE reports
        SET status = CASE
            WHEN status = 'in_progress' THEN 'in_review'
            WHEN status = 'completed' THEN 'archived'
            ELSE status
        END
    """)
    op.execute("DROP TYPE report_status_enum")
    op.execute(
        "CREATE TYPE report_status_enum AS ENUM "
        "('draft', 'in_review', 'approved', 'archived')"
    )
    op.execute(
        "ALTER TABLE reports ALTER COLUMN status TYPE report_status_enum "
        "USING status::report_status_enum"
    )
    op.execute("ALTER TABLE reports ALTER COLUMN status SET DEFAULT 'draft'")
