"""color: tailwind class to hex

Revision ID: 5280dbc086db
Revises: 362a484f9007
Create Date: 2026-05-05 20:51:34.084629

Migrates workspaces.color from Tailwind class strings (e.g. "bg-blue-500")
to standard #rrggbb hex values. After this, the frontend renders colors via
inline `style.backgroundColor`, removing the coupling between the data model
and the CSS framework.

Mapping is exhaustive only for the seed values; anything else falls back to
the default slate (#64748b). Custom colors set after this migration are
already hex.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "5280dbc086db"
down_revision: Union[str, None] = "362a484f9007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Tailwind palette → hex (just the shades the seed used).
TAILWIND_TO_HEX = {
    "bg-blue-500": "#3b82f6",
    "bg-blue-400": "#60a5fa",
    "bg-emerald-500": "#10b981",
    "bg-emerald-400": "#34d399",
    "bg-slate-500": "#64748b",
    "bg-slate-400": "#94a3b8",
    "bg-purple-400": "#c084fc",
    "bg-purple-500": "#a855f7",
    "bg-red-400": "#f87171",
    "bg-red-500": "#ef4444",
    "bg-amber-400": "#fbbf24",
    "bg-amber-500": "#f59e0b",
}


def upgrade() -> None:
    # Per-row UPDATE for known mappings.
    for klass, hex_value in TAILWIND_TO_HEX.items():
        op.execute(
            sa.text(
                "UPDATE workspaces SET color = :hex WHERE color = :klass"
            ).bindparams(klass=klass, hex=hex_value)
        )
    # Catch-all for any remaining Tailwind-shaped string (custom or unknown)
    # → set to the safe default.
    op.execute(
        "UPDATE workspaces SET color = '#64748b' WHERE color LIKE 'bg-%'"
    )

    # Tighten the column to fit only hex.
    op.alter_column(
        "workspaces",
        "color",
        existing_type=sa.String(length=64),
        type_=sa.String(length=16),
        existing_nullable=False,
    )


def downgrade() -> None:
    # Widen the column back; hex values fit in either width.
    op.alter_column(
        "workspaces",
        "color",
        existing_type=sa.String(length=16),
        type_=sa.String(length=64),
        existing_nullable=False,
    )
    # Best-effort reverse mapping (lossy — custom hex values become the
    # original "bg-slate-500" default).
    for klass, hex_value in TAILWIND_TO_HEX.items():
        op.execute(
            sa.text(
                "UPDATE workspaces SET color = :klass WHERE color = :hex"
            ).bindparams(klass=klass, hex=hex_value)
        )
    op.execute(
        "UPDATE workspaces SET color = 'bg-slate-500' WHERE color LIKE '#%'"
    )
