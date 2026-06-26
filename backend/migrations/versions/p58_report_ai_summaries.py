"""phase 58 — 보고서 자동 요약/태깅 저장 (B, B300_보조AI_설계.md §B)

저장 시 백그라운드 summarize_report 잡이 채우는 보고서 1:1 요약 테이블. 요약은
표시물, tags/suggested_category 는 추천(적용은 사람이). pgvector 무관 → 단독 배포.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p58_report_ai_summaries"
down_revision: Union[str, None] = "p57_ai_entitlements"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "report_ai_summaries",
        sa.Column("report_id", sa.Integer(), primary_key=True),
        sa.Column("summary", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "tags",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("suggested_category", sa.Text(), nullable=True),
        sa.Column("content_hash", sa.String(length=64), nullable=True),
        sa.Column("model", sa.String(length=64), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["report_id"], ["reports.id"], ondelete="CASCADE"
        ),
    )


def downgrade() -> None:
    op.drop_table("report_ai_summaries")
