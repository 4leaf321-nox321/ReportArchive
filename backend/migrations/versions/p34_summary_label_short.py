"""phase 34 — 요약 link forward_label '요약본' → '요약'

관계도 엣지 라벨·보고서 상세 표기를 더 짧게. reverse_label('원본')은 그대로.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "p34_summary_label_short"
down_revision: Union[str, None] = "p33_summary_link_direction"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "UPDATE report_link_kinds SET forward_label = '요약' WHERE key = 'summary'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE report_link_kinds SET forward_label = '요약본' WHERE key = 'summary'"
    )
