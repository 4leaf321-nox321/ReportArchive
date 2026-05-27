"""phase 11 — composite_items.group_name

종합보고 안건들을 그룹으로 묶을 수 있게 하기 위한 nullable 컬럼.
같은 group_name 을 가진 연속 안건들은 화면에서 한 그룹으로 묶여 보이고,
Word export 시 그 그룹의 첫 안건 직전에 `[group_name]` 한 줄이 헤더로
삽입된다.

- 별도 groups 마스터 테이블은 만들지 않음. composite 의 distinct non-empty
  group_name 들이 그 composite 의 "그룹 목록" 임.
- NULL / 빈 문자열 = 그룹 없음 (ungrouped). 기존 행들은 NULL 로 마이그레이션.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p11_composite_item_group_name"
down_revision: Union[str, None] = "p10_rt_prefix_per_depth"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "composite_report_items",
        sa.Column("group_name", sa.String(length=128), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("composite_report_items", "group_name")
