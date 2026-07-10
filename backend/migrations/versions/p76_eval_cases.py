"""phase 76 — eval_cases: RAG 검색 평가 골든셋(관리자 UI 편집)

CLI 의 JSON 골든셋을 DB 로 옮겨 "평가" 탭에서 질문·정답 보고서를 관리·실행한다.
빈 테이블 = 케이스 없음(무해).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p76_eval_cases"
down_revision: Union[str, None] = "p75_app_settings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "eval_cases",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("query", sa.Text(), nullable=False),
        sa.Column("expect_report_ids", postgresql.ARRAY(sa.Integer()),
                  nullable=False, server_default="{}"),
        sa.Column("expect_entities", postgresql.ARRAY(sa.String()),
                  nullable=False, server_default="{}"),
        sa.Column("graph", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("eval_cases")
