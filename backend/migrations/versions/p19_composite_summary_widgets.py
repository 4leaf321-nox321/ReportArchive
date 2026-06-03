"""phase 19 — composite_reports.summary_widgets (종합보고 요약 페이지)

"설명"과 "포함된 안건" 사이에 위젯으로 작성하는 자유 콘텐츠(요약 페이지).
템플릿 바인딩 없이 위젯 리스트로 저장한다 — 각 항목 { id, type, props,
content, layout:{x,y,w,h} }. 기존 행은 [](없음).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "p19_composite_summary_widgets"
down_revision: Union[str, None] = "p18_report_presets"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "composite_reports",
        sa.Column(
            "summary_widgets",
            JSONB(),
            nullable=False,
            server_default="[]",
        ),
    )


def downgrade() -> None:
    op.drop_column("composite_reports", "summary_widgets")
