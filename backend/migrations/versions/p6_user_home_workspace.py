"""phase 6 — user.home_workspace_slug

가입자 계정의 '소속 부서'를 명시적으로 한 컬럼으로 들고 있게 한다.
지금까지는 사용자가 어느 부서에 속하는지를 WorkspaceMember 다대다
테이블에만 적어 두었고, 여러 부서에 동시에 멤버일 수 있는 구조였다.
'소속'(primary affiliation) 과 '추가 접근권'(extra membership) 두
개념을 분리하기 위한 칼럼:

  - signup 시 선택한 부서 = home_workspace_slug
  - 그 외 부서 = 계정 관리에서 admin 이 다른 곳으로 옮기거나,
    부서 멤버 페이지에서 추가/제거(home 은 거기서 못 빼고 계정 관리
    에서만 변경 가능)

ON DELETE SET NULL — 부서가 정리되더라도 사용자 계정 자체는 살아 있고,
admin 이 새 home 을 재지정하기 전까지 NULL 로 남겨둔다.

레거시 사용자 backfill: 가장 오래된 비-personal/비-virtual 멤버십을
home 으로 채운다. 그 조건에 맞는 멤버십이 없으면 NULL.

Revision ID: p6_user_home_workspace
Revises: p5b_composite_display_column
Create Date: 2026-05-27
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p6_user_home_workspace"
down_revision: Union[str, None] = "p5b_composite_display_column"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "home_workspace_slug",
            sa.String(length=64),
            sa.ForeignKey("workspaces.slug", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_users_home_workspace_slug",
        "users",
        ["home_workspace_slug"],
    )

    # 백필 — 사용자별로 가장 오래된 org 부서 멤버십을 home 으로.
    # personal/virtual 워크스페이스는 후보에서 제외 (personal 은 자기만
    # 들어가는 개인 공간이고, virtual 은 가상 트리 노드라 가입 대상 아님).
    op.execute(
        """
        UPDATE users u
        SET home_workspace_slug = sub.workspace_slug
        FROM (
            SELECT DISTINCT ON (wm.user_id)
                wm.user_id,
                wm.workspace_slug
            FROM workspace_members wm
            JOIN workspaces w ON w.slug = wm.workspace_slug
            WHERE w.kind = 'org' AND w.virtual = false
            ORDER BY wm.user_id, wm.created_at ASC, wm.id ASC
        ) AS sub
        WHERE u.id = sub.user_id
          AND u.home_workspace_slug IS NULL
        """
    )


def downgrade() -> None:
    op.drop_index("ix_users_home_workspace_slug", table_name="users")
    op.drop_column("users", "home_workspace_slug")
