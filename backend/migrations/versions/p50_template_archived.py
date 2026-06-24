"""phase 50 — 템플릿 보관(아카이브)

템플릿에 보관 상태를 추가한다. 보고서가 참조 중이면 삭제(hard delete)는 여전히
막히지만(렌더 의존 + RESTRICT FK), "보관"하면 작성 picker·기본 목록에서 숨고 새
보고서 작성이 차단된다 — 행은 살아 있어 기존 보고서는 계속 렌더된다.

완전 additive — 기존 행은 archived_at=NULL(=활성) 으로 남는다.

  * templates.archived_at        (보관 시각; NULL = 활성)
  * templates.archived_by_user_id(보관한 사용자 audit; user 삭제 시 SET NULL)

template_id 단위 개념이라 서비스 레이어가 보관 시 그 template_id 의 모든 버전
행에 동일하게 set/clear 한다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p50_template_archived"
down_revision: Union[str, None] = "p49_tf_workspaces"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "templates",
        sa.Column("archived_at", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "templates",
        sa.Column("archived_by_user_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_templates_archived_at", "templates", ["archived_at"]
    )
    op.create_foreign_key(
        "fk_templates_archived_by_user",
        "templates",
        "users",
        ["archived_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_templates_archived_by_user", "templates", type_="foreignkey"
    )
    op.drop_index("ix_templates_archived_at", table_name="templates")
    op.drop_column("templates", "archived_by_user_id")
    op.drop_column("templates", "archived_at")
