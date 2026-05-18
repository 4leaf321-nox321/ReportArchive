"""reports.pages — multi-page reports

Revision ID: c5a31f80b412
Revises: a7c2e9b41f08
Create Date: 2026-05-15 00:00:00.000000

Adds a `pages` JSONB column to `reports` holding an ordered list of
`{template_id, template_version, content, layout_overrides}` entries.

Existing single-template rows are backfilled to `pages = [{... mirror of
top-level columns ...}]` so the application layer can rely on `pages`
being non-empty for every persisted report.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "c5a31f80b412"
down_revision: Union[str, None] = "a7c2e9b41f08"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add the column as NOT NULL with a server-side default of [] so the
    # ALTER doesn't break the running app between deploy and backfill. We
    # drop the default at the end — the application supplies a populated
    # list on every insert.
    op.add_column(
        "reports",
        sa.Column(
            "pages",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )

    # Backfill: synthesize one page entry per existing row from the
    # already-present top-level fields. Using a single UPDATE keeps this
    # O(1) round-trip even on large tables.
    op.execute(
        """
        UPDATE reports
        SET pages = jsonb_build_array(
            jsonb_build_object(
                'template_id', template_id,
                'template_version', template_version,
                'content', COALESCE(content, '{}'::jsonb),
                'layout_overrides', layout_overrides
            )
        )
        WHERE jsonb_array_length(pages) = 0
        """
    )

    op.alter_column("reports", "pages", server_default=None)


def downgrade() -> None:
    op.drop_column("reports", "pages")
