"""phase 73 — led_by 라벨 '담당 PL' → '담당자'

관계 표시명만 바꾼다(슬러그·제약 불변). 프론트 드롭다운은 relation_types.label 을 읽어
자동 반영. p72(released)는 건드리지 않고 전방 갱신.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p73_led_by_label"
down_revision: Union[str, None] = "p72_led_by_relation"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.get_bind().execute(
        sa.text("UPDATE relation_types SET label = '담당자' WHERE slug = 'led_by'")
    )


def downgrade() -> None:
    op.get_bind().execute(
        sa.text("UPDATE relation_types SET label = '담당 PL' WHERE slug = 'led_by'")
    )
