"""phase 33 — '요약본' link 방향 정정

p32 는 from=요약본 → to=원본, forward_label='원본' 으로 넣어, 관계도 엣지가
요약본→원본 으로 그려지고 라벨이 '원본' 으로 보였다. 원본→요약본 방향(라벨
'요약본')이 더 자연스러워 뒤집는다:

  - report_link_kinds.summary: forward_label '요약본', reverse_label '원본'
  - 기존 report_links(kind='summary') 의 from/to 를 한 번 swap

Postgres 는 한 UPDATE 의 SET 을 OLD 값으로 평가하므로 from/to 동시 swap 안전.
(from,to,kind) unique 충돌도 없음 — 각 요약 쌍은 row 한 개뿐.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "p33_summary_link_direction"
down_revision: Union[str, None] = "p32_summary_link_kind"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE report_link_kinds
           SET forward_label = '요약본', reverse_label = '원본'
         WHERE key = 'summary'
        """
    )
    op.execute(
        """
        UPDATE report_links
           SET from_report_id = to_report_id, to_report_id = from_report_id
         WHERE kind = 'summary'
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE report_links
           SET from_report_id = to_report_id, to_report_id = from_report_id
         WHERE kind = 'summary'
        """
    )
    op.execute(
        """
        UPDATE report_link_kinds
           SET forward_label = '원본', reverse_label = '요약본'
         WHERE key = 'summary'
        """
    )
