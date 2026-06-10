"""phase 32 — '요약본' link kind seed

"요약본 만들기" 복사 모드가 원본↔요약 보고서를 연결할 때 쓰는 link kind.
링크는 from=요약본 → to=원본 으로 건다:
  - 요약본 보고서(from)에서는 forward_label '원본'  → "원본: [원본 보고서]"
  - 원본 보고서(to)에서는   reverse_label '요약본' → "요약본: [요약 보고서]"

system_locked=True — admin 에서 라벨/색은 바꿀 수 있어도 key 변경·삭제는 불가
(기능이 이 key 에 의존). p14 의 reference/successor seed 와 같은 방식.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "p32_summary_link_kind"
down_revision: Union[str, None] = "p31_composite_detach_on_purge"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 이미 있으면(수동 추가 등) 건너뜀 — 멱등.
    op.execute(
        """
        INSERT INTO report_link_kinds
          (key, forward_label, reverse_label, color, sort_order, system_locked)
        VALUES
          ('summary', '원본', '요약본', 'purple', 3, true)
        ON CONFLICT (key) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute("DELETE FROM report_link_kinds WHERE key = 'summary'")
