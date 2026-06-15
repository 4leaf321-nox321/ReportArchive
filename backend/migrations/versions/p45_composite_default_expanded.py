"""phase 45 — composite_reports.default_expanded (모두 펼치기/접기 상태 영속)

종합보고 단일 보기에서 각 안건을 인라인으로 펼친/접은 상태가 화면 로컬
state(expanded Set)로만 있어 새로고침하면 사라졌다. "모두 펼치기/접기"가
유지되도록, 기본 펼침 여부를 불리언으로 저장한다. 기존 행은 false(접힘).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p45_composite_default_expanded"
down_revision: Union[str, None] = "p44_composite_groups"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "composite_reports",
        sa.Column(
            "default_expanded",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )


def downgrade() -> None:
    op.drop_column("composite_reports", "default_expanded")
