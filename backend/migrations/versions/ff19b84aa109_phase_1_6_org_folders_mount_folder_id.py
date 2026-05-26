"""phase 1_6 org folders + mount folder_id

Lifts folders from per-user only to per-user OR per-workspace,
keeping a single table with a `kind` discriminator. Adds
ReportMount.folder_id so the same Report can sit in different org
folders on different boards (folder = placement, not content).

Revision ID: ff19b84aa109
Revises: 3a37db1362ff
Create Date: 2026-05-25 05:10:20.582133

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "ff19b84aa109"
down_revision: Union[str, None] = "3a37db1362ff"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ─── folders.kind ──────────────────────────────────────────────
    # Explicit enum create — add_column can't auto-register the type
    # the way create_table can.
    folder_kind_enum = postgresql.ENUM(
        "personal", "org", name="folder_kind_enum"
    )
    folder_kind_enum.create(op.get_bind(), checkfirst=True)
    op.add_column(
        "folders",
        sa.Column(
            "kind",
            folder_kind_enum,
            server_default="personal",
            nullable=False,
        ),
    )

    # ─── folders.workspace_slug + user_id loosen ────────────────────
    op.add_column(
        "folders",
        sa.Column("workspace_slug", sa.String(length=64), nullable=True),
    )
    op.alter_column(
        "folders", "user_id", existing_type=sa.INTEGER(), nullable=True
    )
    op.drop_index("ix_folders_user_id", table_name="folders")
    op.create_index(
        "ix_folders_workspace_parent",
        "folders",
        ["workspace_slug", "parent_id"],
        unique=False,
    )
    op.create_foreign_key(
        "fk_folders_workspace",
        "folders",
        "workspaces",
        ["workspace_slug"],
        ["slug"],
        ondelete="CASCADE",
    )

    # ─── folders CHECK: scope matches kind ─────────────────────────
    op.create_check_constraint(
        "ck_folders_scope_matches_kind",
        "folders",
        "(kind = 'personal' AND user_id IS NOT NULL AND workspace_slug IS NULL) OR "
        "(kind = 'org' AND workspace_slug IS NOT NULL AND user_id IS NULL)",
    )

    # ─── report_mounts.folder_id ────────────────────────────────────
    op.add_column(
        "report_mounts",
        sa.Column("folder_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        op.f("ix_report_mounts_folder_id"),
        "report_mounts",
        ["folder_id"],
        unique=False,
    )
    op.create_foreign_key(
        "fk_report_mounts_folder",
        "report_mounts",
        "folders",
        ["folder_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_report_mounts_folder", "report_mounts", type_="foreignkey"
    )
    op.drop_index(
        op.f("ix_report_mounts_folder_id"), table_name="report_mounts"
    )
    op.drop_column("report_mounts", "folder_id")

    op.drop_constraint(
        "ck_folders_scope_matches_kind", "folders", type_="check"
    )
    op.drop_constraint("fk_folders_workspace", "folders", type_="foreignkey")
    op.drop_index("ix_folders_workspace_parent", table_name="folders")
    # Existing data with NULL user_id (= org folders) would break the
    # NOT NULL revert. Pre-production downgrade — wipe org folders
    # first so the alter succeeds, then restore the index.
    op.execute(
        "DELETE FROM report_mounts WHERE folder_id IS NOT NULL"
    )  # cleared by FK SET NULL already, but explicit
    op.execute("DELETE FROM folders WHERE kind = 'org'")
    op.alter_column(
        "folders", "user_id", existing_type=sa.INTEGER(), nullable=False
    )
    op.create_index("ix_folders_user_id", "folders", ["user_id"], unique=False)
    op.drop_column("folders", "workspace_slug")
    op.drop_column("folders", "kind")
    op.execute("DROP TYPE folder_kind_enum")
