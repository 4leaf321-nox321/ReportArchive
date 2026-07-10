"""phase 77 — qa_feedback: AI 질문하기 답변 👍/👎 수집

수집 자체로 품질 신호 + 👍 는 평가 골든셋(eval_cases) 승격 씨앗. 랭킹 학습은 후속.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p77_qa_feedback"
down_revision: Union[str, None] = "p76_eval_cases"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "qa_feedback",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("query", sa.Text(), nullable=False),
        sa.Column("rating", sa.Integer(), nullable=False),
        sa.Column("report_ids", postgresql.ARRAY(sa.Integer()),
                  nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_qa_feedback_rating", "qa_feedback", ["rating"])


def downgrade() -> None:
    op.drop_index("ix_qa_feedback_rating", table_name="qa_feedback")
    op.drop_table("qa_feedback")
