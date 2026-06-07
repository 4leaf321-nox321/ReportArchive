"""phase 26 — 폴더 통째 공유(folder_grants)

게시판 공유(p25)를 폴더 단위로도. 폴더 F 를 부서/전체/개인에 공유하면 F 에
게시된 보고서가 그 대상에게 보인다. content_grant/board_grant 와 같은
principal/level enum 재사용(create_type=False).

백필: 기존 폴더 공개(folder.external_view=true) → folder_grant(all_org, view).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p26_folder_grants"
down_revision: Union[str, None] = "p25_board_grants"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    principal_enum = postgresql.ENUM(
        "workspace", "all_org", "user",
        name="grant_principal_type_enum",
        create_type=False,
    )
    level_enum = postgresql.ENUM(
        "view", "edit", name="grant_level_enum", create_type=False
    )
    op.create_table(
        "folder_grants",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("folder_id", sa.Integer(), nullable=False),
        sa.Column("principal_type", principal_enum, nullable=False),
        sa.Column("principal_ref", sa.String(length=64), nullable=True),
        sa.Column("level", level_enum, nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["folder_id"], ["folders.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.UniqueConstraint(
            "folder_id", "principal_type", "principal_ref",
            name="uq_folder_grant_target",
        ),
    )
    op.create_index("ix_folder_grants_folder", "folder_grants", ["folder_id"])
    op.create_index(
        "ix_folder_grants_principal", "folder_grants", ["principal_type", "principal_ref"]
    )
    op.create_index(
        "uq_folder_grant_all_org",
        "folder_grants",
        ["folder_id"],
        unique=True,
        postgresql_where=sa.text("principal_type = 'all_org'"),
    )

    # 백필: 폴더 공개(external_view TRUE) → folder all_org view.
    op.execute(
        """
        INSERT INTO folder_grants
            (folder_id, principal_type, principal_ref, level, created_at)
        SELECT f.id, 'all_org'::grant_principal_type_enum, NULL,
               'view'::grant_level_enum, now()
        FROM folders f
        WHERE f.external_view IS TRUE
        ON CONFLICT (folder_id) WHERE principal_type = 'all_org' DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_index("uq_folder_grant_all_org", table_name="folder_grants")
    op.drop_index("ix_folder_grants_principal", table_name="folder_grants")
    op.drop_index("ix_folder_grants_folder", table_name="folder_grants")
    op.drop_table("folder_grants")
