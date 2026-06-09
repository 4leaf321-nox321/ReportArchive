"""phase 29 — reports 소프트삭제(휴지통) 컬럼

보고서 삭제 재설계 1단계. "삭제"를 즉시 cascade 파괴에서 소프트삭제로 바꾸기
위한 컬럼:
  - deleted_at         : set 되면 작성자 개인 목록/검색에서 숨김(휴지통).
                         게시(mount)된 부서 게시판에는 그대로 남는다(게시분 보존).
  - deleted_by_user_id : 누가 삭제했는지(감사용). 사용자 삭제 시 SET NULL.

기존 행은 모두 deleted_at IS NULL(살아있음)로 시작 — 백필 불필요.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p29_report_soft_delete"
down_revision: Union[str, None] = "p28_password_reset"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "reports",
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "reports",
        sa.Column("deleted_by_user_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_reports_deleted_at", "reports", ["deleted_at"], unique=False
    )
    op.create_foreign_key(
        "fk_reports_deleted_by_user",
        "reports",
        "users",
        ["deleted_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_reports_deleted_by_user", "reports", type_="foreignkey")
    op.drop_index("ix_reports_deleted_at", table_name="reports")
    op.drop_column("reports", "deleted_by_user_id")
    op.drop_column("reports", "deleted_at")
