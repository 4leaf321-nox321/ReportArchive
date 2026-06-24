"""phase 49 — TF(태스크포스) 워크스페이스 기반

공식 조직도(org 트리) 밖의 한시·교차기능 TF 조직을 위한 스키마 확장. 완전 additive —
기존 행/스키마 의미 변경 없음(기존 워크스페이스는 status='active' 로 백필).

  * workspace_kind_enum 에 'tf' 값 추가.
  * workspace_status_enum(active/archived) 신설 + workspaces.status (기존 행 active).
  * workspaces.archived_at / archived_by_user_id (수명 audit).
  * workspaces.created_by_user_id (TF 개설자 추적 — 보직장 self-service 라 누가
    열었는지 기록; org 는 NULL).

설계: TF조직_설계.md.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p49_tf_workspaces"
down_revision: Union[str, None] = "p48_report_chunks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. 기존 workspace_kind_enum 에 'tf' 추가. PG 12+ 는 트랜잭션 안에서 ADD VALUE
    #    가능(같은 트랜잭션에서 그 값을 *사용* 만 안 하면 됨 — 여기선 컬럼만 추가).
    op.execute("ALTER TYPE workspace_kind_enum ADD VALUE IF NOT EXISTS 'tf'")

    # 2. workspace_status_enum 신설(standalone add_column 전에 CREATE 필요).
    workspace_status_enum = postgresql.ENUM(
        "active", "archived", name="workspace_status_enum"
    )
    workspace_status_enum.create(op.get_bind(), checkfirst=True)
    op.add_column(
        "workspaces",
        sa.Column(
            "status",
            workspace_status_enum,
            nullable=False,
            server_default="active",
        ),
    )

    # 3. 수명 audit + 개설자.
    op.add_column(
        "workspaces", sa.Column("archived_at", sa.DateTime(), nullable=True)
    )
    op.add_column(
        "workspaces",
        sa.Column("archived_by_user_id", sa.Integer(), nullable=True),
    )
    op.add_column(
        "workspaces",
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_workspaces_archived_by",
        "workspaces",
        "users",
        ["archived_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_workspaces_created_by",
        "workspaces",
        "users",
        ["created_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_workspaces_created_by", "workspaces", type_="foreignkey")
    op.drop_constraint("fk_workspaces_archived_by", "workspaces", type_="foreignkey")
    op.drop_column("workspaces", "created_by_user_id")
    op.drop_column("workspaces", "archived_by_user_id")
    op.drop_column("workspaces", "archived_at")
    op.drop_column("workspaces", "status")
    sa.Enum(name="workspace_status_enum").drop(op.get_bind(), checkfirst=True)
    # workspace_kind_enum 의 'tf' 값은 PG 가 enum value DROP 을 지원하지 않아
    # 남겨둔다(무해 — 트리 밖 미사용 값). 완전 제거가 필요하면 enum 재생성 필요.