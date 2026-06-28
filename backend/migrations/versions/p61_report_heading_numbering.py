"""report page_heading_numbering column

문서(보고서) 단위 "절 번호 자동매김" 토글. True 면 문서 순서대로 heading 위젯에
레벨별 계층 번호(1 / 1.1 / 1.1.1)를 렌더 시 계산해 붙인다(규격서·논문용).
NULL/False 면 현행과 동일(번호 없음) — 기존 보고서는 모두 NULL 로 남아 변화 없음.
번호는 그림/표 번호처럼 저장하지 않고 렌더 시점에 계산한다.

Revision ID: p61_report_heading_numbering
Revises: p60_entity_merge
Create Date: 2026-06-28 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p61_report_heading_numbering"
down_revision: Union[str, None] = "p60_entity_merge"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "reports",
        sa.Column("page_heading_numbering", sa.Boolean(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("reports", "page_heading_numbering")
