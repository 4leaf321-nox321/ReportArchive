"""report slide-guide columns

Revision ID: d7c4f29a8b35
Revises: c3a5d8f17b22
Create Date: 2026-05-23 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d7c4f29a8b35"
down_revision: Union[str, None] = "c3a5d8f17b22"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # PPT export 시 한 슬라이드가 차지할 세로 경계를 본문에 점선으로
    # 표시하는 가이드 기능. 4개 컬럼 모두 nullable로 두고, 프론트는
    # NULL을 "가이드 OFF"로 취급한다. 기존 보고서는 손대지 않음.
    #
    # page_slide_ratio 는 "16:9" / "4:3" / "16:10" / "custom" 중 하나.
    # custom 일 때만 page_slide_ratio_custom_w / _custom_h 가 사용된다.
    # (서버는 enum 검증을 Pydantic 쪽에 위임하고 DB 타입은 VARCHAR.)
    op.add_column(
        "reports",
        sa.Column("page_slide_guide", sa.Boolean(), nullable=True),
    )
    op.add_column(
        "reports",
        sa.Column("page_slide_ratio", sa.String(length=16), nullable=True),
    )
    op.add_column(
        "reports",
        sa.Column("page_slide_ratio_custom_w", sa.Integer(), nullable=True),
    )
    op.add_column(
        "reports",
        sa.Column("page_slide_ratio_custom_h", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("reports", "page_slide_ratio_custom_h")
    op.drop_column("reports", "page_slide_ratio_custom_w")
    op.drop_column("reports", "page_slide_ratio")
    op.drop_column("reports", "page_slide_guide")
