"""phase 46 — 종합보고 워크스페이스 기본 공유(composite_default_grants)

워크스페이스(부서) W 에 이 grant 를 걸면 W 가 home 인 모든 종합보고(기존·신규)가
그 대상에게 보인다 — 라이브 상속(복사 없음, 읽기 시점 합산). 게시판 통째 공유
(BoardGrant)와 달리 *종합보고에만* 적용돼 보고서까지 묶지 않는다.

ContentGrant/BoardGrant 와 같은 principal/level enum 을 재사용(create_type=False).
신규 테이블만 생성 — 백필 없음(기존 데이터 변경 없음).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p46_composite_default_grant"
down_revision: Union[str, None] = "p45_composite_default_expanded"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    principal_enum = postgresql.ENUM(
        "workspace",
        "all_org",
        "user",
        "workspace_manager",
        name="grant_principal_type_enum",
        create_type=False,
    )
    level_enum = postgresql.ENUM(
        "view", "edit", name="grant_level_enum", create_type=False
    )
    op.create_table(
        "composite_default_grants",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("workspace_slug", sa.String(length=64), nullable=False),
        sa.Column("principal_type", principal_enum, nullable=False),
        sa.Column("principal_ref", sa.String(length=64), nullable=True),
        sa.Column("level", level_enum, nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.ForeignKeyConstraint(
            ["workspace_slug"], ["workspaces.slug"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.UniqueConstraint(
            "workspace_slug",
            "principal_type",
            "principal_ref",
            name="uq_composite_default_grant_target",
        ),
    )
    op.create_index(
        "ix_composite_default_grants_ws",
        "composite_default_grants",
        ["workspace_slug"],
    )
    op.create_index(
        "ix_composite_default_grants_principal",
        "composite_default_grants",
        ["principal_type", "principal_ref"],
    )
    # all_org 은 워크스페이스당 하나만(principal_ref NULL 이라 UNIQUE 제약이 못 막음).
    op.create_index(
        "uq_composite_default_grant_all_org",
        "composite_default_grants",
        ["workspace_slug"],
        unique=True,
        postgresql_where=sa.text("principal_type = 'all_org'"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_composite_default_grant_all_org",
        table_name="composite_default_grants",
    )
    op.drop_index(
        "ix_composite_default_grants_principal",
        table_name="composite_default_grants",
    )
    op.drop_index(
        "ix_composite_default_grants_ws", table_name="composite_default_grants"
    )
    op.drop_table("composite_default_grants")
    # enum 타입은 content_grants 와 공유하므로 여기서 drop 하지 않는다.
