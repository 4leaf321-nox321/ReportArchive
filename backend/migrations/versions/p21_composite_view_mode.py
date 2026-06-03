"""phase 21 — composite_reports.view_mode (단일/2단/리스트 보기 모드)

종합보고 화면 보기 모드를 boolean(two_col_view)에서 3-state 문자열로 확장:
  'single' | 'two_col' | 'list'(리스트와 함께 보기 — 좌측 목록 + 우측 상세).
기존 행은 two_col_view 값으로 백필(true → 'two_col', false → 'single').
two_col_view 컬럼은 하위호환용으로 남겨 둔다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p21_composite_view_mode"
down_revision: Union[str, None] = "p20_report_collab_workspaces"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "composite_reports",
        sa.Column(
            "view_mode",
            sa.String(length=16),
            nullable=False,
            server_default="single",
        ),
    )
    # 기존 보기 설정 백필 — two_col_view=true 였던 종합보고는 '2단' 유지.
    op.execute(
        "UPDATE composite_reports SET view_mode = 'two_col' WHERE two_col_view = true"
    )


def downgrade() -> None:
    op.drop_column("composite_reports", "view_mode")
