"""workspace colors: auto-assign from tree hierarchy

Revision ID: a3e4f9c81d27
Revises: d52e3a17c904
Create Date: 2026-05-21 18:00:00.000000

Backfills `workspaces.color` from the tree shape: every node's color is
chosen so it differs from its parent and from each of its siblings.
Previously colors were picked manually in the admin UI; the picker is
now gone, so any hand-edited values get overwritten by this migration.

The Python algorithm here is duplicated from
`app.modules.workspaces.services.compute_workspace_colors` on purpose —
alembic migrations stay forward-compatible by avoiding imports of the
live app modules (whose code may have moved by the time someone runs an
older migration).
"""
from typing import Optional, Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "a3e4f9c81d27"
down_revision: Union[str, None] = "d52e3a17c904"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_PALETTE: tuple[str, ...] = (
    "#3b82f6",  # blue
    "#10b981",  # emerald
    "#f59e0b",  # amber
    "#a855f7",  # purple
    "#ef4444",  # red
    "#06b6d4",  # cyan
    "#84cc16",  # lime
    "#ec4899",  # pink
    "#6366f1",  # indigo
    "#14b8a6",  # teal
    "#f97316",  # orange
    "#8b5cf6",  # violet
)
_VIRTUAL_COLOR = "#64748b"


def _compute(rows: list[dict]) -> dict[str, str]:
    children_of: dict[Optional[str], list[dict]] = {}
    for r in rows:
        children_of.setdefault(r["parent_slug"], []).append(r)
    for siblings in children_of.values():
        siblings.sort(key=lambda r: (r["sort_order"], r["slug"]))

    out: dict[str, str] = {}
    n = len(_PALETTE)

    def walk(node: dict, idx: int) -> None:
        out[node["slug"]] = _PALETTE[idx % n]
        for i, child in enumerate(children_of.get(node["slug"], [])):
            if child["virtual"]:
                out[child["slug"]] = _VIRTUAL_COLOR
                continue
            walk(child, idx + 1 + i)

    real_roots = sorted(
        (r for r in rows if r["parent_slug"] is None and not r["virtual"]),
        key=lambda r: (r["created_at"], r["slug"]),
    )
    for i, r in enumerate(real_roots):
        walk(r, i)

    for r in rows:
        if r["slug"] not in out:
            out[r["slug"]] = _VIRTUAL_COLOR
    return out


def upgrade() -> None:
    bind = op.get_bind()
    rows = [
        dict(row._mapping)
        for row in bind.execute(
            sa.text(
                "SELECT slug, parent_slug, virtual, created_at, sort_order "
                "FROM workspaces"
            )
        )
    ]
    if not rows:
        return
    colors = _compute(rows)
    for slug, color in colors.items():
        bind.execute(
            sa.text("UPDATE workspaces SET color = :color WHERE slug = :slug"),
            {"color": color, "slug": slug},
        )


def downgrade() -> None:
    # Colors used to be hand-picked; we can't recover the originals. Best
    # we can do is reset to the historical default so the column stays
    # populated and valid.
    op.execute("UPDATE workspaces SET color = '#64748b'")
