"""templates.owner_workspace_slug -> owner_workspace_slugs array

Revision ID: f6c168512385
Revises: e85f28ba1521
Create Date: 2026-05-06 19:58:00.521838

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'f6c168512385'
down_revision: Union[str, None] = 'e85f28ba1521'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Add the new array column.
    op.add_column(
        'templates',
        sa.Column(
            'owner_workspace_slugs',
            postgresql.ARRAY(sa.String(length=64)),
            nullable=True,
        ),
    )
    # 2. Backfill from the old single-value column. Non-null single slug
    #    becomes a one-element array; NULL stays NULL (= global).
    op.execute(
        "UPDATE templates "
        "SET owner_workspace_slugs = ARRAY[owner_workspace_slug] "
        "WHERE owner_workspace_slug IS NOT NULL"
    )
    # 3. Swap indexes and drop the old column.
    op.drop_index('ix_templates_owner_workspace', table_name='templates')
    op.create_index(
        'ix_templates_owner_workspaces',
        'templates',
        ['owner_workspace_slugs'],
        unique=False,
    )
    op.drop_constraint('templates_owner_workspace_slug_fkey', 'templates', type_='foreignkey')
    op.drop_column('templates', 'owner_workspace_slug')


def downgrade() -> None:
    # Best-effort revert: take the first slug of the array as the single
    # owner. Templates owned by multiple workspaces will lose all but one.
    op.add_column(
        'templates',
        sa.Column('owner_workspace_slug', sa.VARCHAR(length=64), autoincrement=False, nullable=True),
    )
    op.execute(
        "UPDATE templates "
        "SET owner_workspace_slug = owner_workspace_slugs[1] "
        "WHERE owner_workspace_slugs IS NOT NULL "
        "  AND array_length(owner_workspace_slugs, 1) >= 1"
    )
    op.create_foreign_key(
        'templates_owner_workspace_slug_fkey',
        'templates',
        'workspaces',
        ['owner_workspace_slug'],
        ['slug'],
        ondelete='RESTRICT',
    )
    op.drop_index('ix_templates_owner_workspaces', table_name='templates')
    op.create_index('ix_templates_owner_workspace', 'templates', ['owner_workspace_slug'], unique=False)
    op.drop_column('templates', 'owner_workspace_slugs')
