"""report page_default_view_mode — 보고서별 기본 보기 모드 (페이지별/전체), 백필 없음.

Revision ID: p40_report_default_view_mode
Revises: p39_personal_access_tokens
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "p40_report_default_view_mode"
down_revision: Union[str, None] = "p39_personal_access_tokens"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable, no server_default. 기존 행은 NULL 로 남고 프런트가
    # 개인 전역설정(localStorage)→"paginated" 로 폴백한다. 다른 page_*
    # 설정과 동일한 패턴. 값은 "paginated" / "all".
    op.add_column(
        "reports",
        sa.Column("page_default_view_mode", sa.String(length=16), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("reports", "page_default_view_mode")
