"""add password_hash + rename role values

Revision ID: b9a7408dd411
Revises: 19d4b398b211
Create Date: 2026-05-05 17:56:58.650420

Changes:
  - users.password_hash (nullable) — bcrypt for JWT login
  - role_enum: rename 'editor' → 'manager', 'viewer' → 'user'

The enum rename is done via PostgreSQL's ALTER TYPE ... RENAME VALUE TO ...,
which preserves all existing rows referencing the old labels. Autogenerate
doesn't detect this — added manually.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b9a7408dd411'
down_revision: Union[str, None] = '19d4b398b211'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. password_hash column
    op.add_column('users', sa.Column('password_hash', sa.String(length=255), nullable=True))

    # 2. Rename enum values. ALTER TYPE ... RENAME VALUE preserves data.
    #    Skip if the source label doesn't exist (idempotent for partial states).
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_enum e
                JOIN pg_type t ON e.enumtypid = t.oid
                WHERE t.typname = 'role_enum' AND e.enumlabel = 'editor'
            ) THEN
                ALTER TYPE role_enum RENAME VALUE 'editor' TO 'manager';
            END IF;
            IF EXISTS (
                SELECT 1 FROM pg_enum e
                JOIN pg_type t ON e.enumtypid = t.oid
                WHERE t.typname = 'role_enum' AND e.enumlabel = 'viewer'
            ) THEN
                ALTER TYPE role_enum RENAME VALUE 'viewer' TO 'user';
            END IF;
        END$$;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_enum e
                JOIN pg_type t ON e.enumtypid = t.oid
                WHERE t.typname = 'role_enum' AND e.enumlabel = 'user'
            ) THEN
                ALTER TYPE role_enum RENAME VALUE 'user' TO 'viewer';
            END IF;
            IF EXISTS (
                SELECT 1 FROM pg_enum e
                JOIN pg_type t ON e.enumtypid = t.oid
                WHERE t.typname = 'role_enum' AND e.enumlabel = 'manager'
            ) THEN
                ALTER TYPE role_enum RENAME VALUE 'manager' TO 'editor';
            END IF;
        END$$;
        """
    )
    op.drop_column('users', 'password_hash')
