"""phase 23 — 종합보고 조직 간 공개(external_view) 컬럼

보고서의 조직 간 공개(p16)를 종합보고에도 확장한다(공개범위_정리.md). 보고서는
mount·폴더에 공개가 매달리지만 종합보고는 mount/폴더가 없어 종합보고 자체에
boolean 으로 단다.

  - composite_reports.external_view : 이 종합보고를 다른 조직이 읽기전용으로
    조회 가능한가. org 워크스페이스 소속일 때만 의미(personal/virtual 무시).

기존 행은 false = 현행 완전 격리 유지(무동작 디폴트).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p23_composite_external_view"
down_revision: Union[str, None] = "p22_composite_item_requests"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "composite_reports",
        sa.Column(
            "external_view",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("composite_reports", "external_view")
