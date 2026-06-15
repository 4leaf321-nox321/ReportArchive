"""phase 44 — composite_reports.groups (빈 그룹 골격 영속)

종합보고 그룹은 그동안 `composite_report_items.group_name` 문자열로만 존재해,
안건이 하나도 없는 "빈 그룹"은 DB 에 들어갈 곳이 없어 저장/새로고침하면
사라졌다. 그룹 순서(빈 그룹 포함)를 담는 문자열 리스트 컬럼을 추가해 빈
그룹도 영속한다. 기존 행은 [](없음) — 로드 시 item 의 group_name 에서
자동 보충(self-heal)되므로 백필 불필요.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "p44_composite_groups"
down_revision: Union[str, None] = "p43_workspace_pinned_reports"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "composite_reports",
        sa.Column(
            "groups",
            JSONB(),
            nullable=False,
            server_default="[]",
        ),
    )


def downgrade() -> None:
    op.drop_column("composite_reports", "groups")
