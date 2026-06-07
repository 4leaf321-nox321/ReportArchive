"""phase 25 — 게시판(워크스페이스) 통째 공유(board_grants)

게시판 B 를 부서/전체/개인에 공유하면 B 에 게시된 보고서·B 가 home 인 종합보고가
그 대상에게 보인다(공유/권한 개편 후속). ContentGrant 와 같은 principal/level
enum 을 재사용한다(p24 에서 생성됨 → create_type=False).

백필: 기존 게시판 기본 공개(workspace.external_view_default=true) → board_grant
(all_org, view) 로 이관해 '그 게시판 전체 공개' 의도를 유지. (개별 공개 보고서는
p24 에서 이미 per-report all_org grant 로 백필됨.)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p25_board_grants"
down_revision: Union[str, None] = "p24_content_grants"
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
        "board_grants",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("board_slug", sa.String(length=64), nullable=False),
        sa.Column("principal_type", principal_enum, nullable=False),
        sa.Column("principal_ref", sa.String(length=64), nullable=True),
        sa.Column("level", level_enum, nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["board_slug"], ["workspaces.slug"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.UniqueConstraint(
            "board_slug", "principal_type", "principal_ref",
            name="uq_board_grant_target",
        ),
    )
    op.create_index("ix_board_grants_board", "board_grants", ["board_slug"])
    op.create_index(
        "ix_board_grants_principal", "board_grants", ["principal_type", "principal_ref"]
    )
    op.create_index(
        "uq_board_grant_all_org",
        "board_grants",
        ["board_slug"],
        unique=True,
        postgresql_where=sa.text("principal_type = 'all_org'"),
    )

    # 백필: 게시판 기본 공개 → board all_org view.
    op.execute(
        """
        INSERT INTO board_grants
            (board_slug, principal_type, principal_ref, level, created_at)
        SELECT w.slug, 'all_org'::grant_principal_type_enum, NULL,
               'view'::grant_level_enum, now()
        FROM workspaces w
        WHERE w.kind = 'org' AND w.external_view_default IS TRUE
        ON CONFLICT (board_slug) WHERE principal_type = 'all_org' DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_index("uq_board_grant_all_org", table_name="board_grants")
    op.drop_index("ix_board_grants_principal", table_name="board_grants")
    op.drop_index("ix_board_grants_board", table_name="board_grants")
    op.drop_table("board_grants")
    # enum 타입은 content_grants 와 공유하므로 여기서 drop 하지 않는다.
