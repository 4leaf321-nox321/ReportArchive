"""phase 84 — ai_conversations: 대화형 에이전트 검색 대화 영구 저장

대화(스레드 전체)를 사용자별로 저장·되살리기. messages 는 JSONB 통째.
설계: docs/[미구현] 대화형_에이전트_검색_설계.md §11.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p84_ai_conversations"
down_revision: Union[str, None] = "p83_alert_notify_owner"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ai_conversations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(200), nullable=False, server_default=""),
        sa.Column("messages", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_ai_conversations_user_updated", "ai_conversations",
                    ["user_id", "updated_at"])


def downgrade() -> None:
    op.drop_index("ix_ai_conversations_user_updated", table_name="ai_conversations")
    op.drop_table("ai_conversations")
