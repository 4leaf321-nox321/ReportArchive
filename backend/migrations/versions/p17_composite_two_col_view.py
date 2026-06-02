"""phase 17 — composite_reports.two_col_view (종합보고 "2단 미리보기" 보기 모드 저장)

종합보고 화면의 "단일 보기 / 2단 미리보기" 토글을 저장한다. 항목별
`composite_report_items.display_column`(DOCX 2단 출력용)과는 별개로, 이건
본문 전체를 좌·우 2열 그리드로 펼쳐 보는 순수 화면 보기 상태다. 기존 행은
false(= 단일 보기) 로 남으므로 현행 동작 그대로.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p17_composite_two_col_view"
down_revision: Union[str, None] = "p16_cross_org_external_view"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "composite_reports",
        sa.Column(
            "two_col_view",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("composite_reports", "two_col_view")
