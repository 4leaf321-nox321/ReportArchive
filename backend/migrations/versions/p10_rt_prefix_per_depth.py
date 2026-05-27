"""phase 10 — per-depth rich_text prefix override

p9 에서 보고서별로 긴 글 위젯의 depth-0 머리 기호를 지정할 수 있게 했는데,
"왜 depth 0 만 되냐, 나머지 depth(상세 / 깊은 설명) 도 같이 바꾸게 해 달라"
는 피드백을 반영해 컬럼을 한 벌(3개)로 확장한다.

  - page_rich_text_prefix       → page_rich_text_prefix_d0  (rename)
  - page_rich_text_prefix_d1    NEW  (depth 1 — 상세)
  - page_rich_text_prefix_d2    NEW  (depth 2+ — 깊은 설명, 깊은 들여쓰기는
                                      depth 2 의 글리프를 그대로 이어 쓴다)

rename 이므로 기존 데이터는 그대로 보존됨 (Postgres ALTER COLUMN ... RENAME
은 data preserving). NULL/빈 문자열은 프런트의 기본 글리프 폴백을 그대로
탐.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p10_rt_prefix_per_depth"
down_revision: Union[str, None] = "p9_report_rich_text_prefix"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "reports",
        "page_rich_text_prefix",
        new_column_name="page_rich_text_prefix_d0",
    )
    op.add_column(
        "reports",
        sa.Column("page_rich_text_prefix_d1", sa.String(length=8), nullable=True),
    )
    op.add_column(
        "reports",
        sa.Column("page_rich_text_prefix_d2", sa.String(length=8), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("reports", "page_rich_text_prefix_d2")
    op.drop_column("reports", "page_rich_text_prefix_d1")
    op.alter_column(
        "reports",
        "page_rich_text_prefix_d0",
        new_column_name="page_rich_text_prefix",
    )
