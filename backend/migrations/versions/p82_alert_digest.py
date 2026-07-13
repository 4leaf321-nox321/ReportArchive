"""phase 82 — alert_digest_runs: 경보 이메일 다이제스트 발송 이력/워터마크 (Phase D 3b)

일일 다이제스트가 "직전 발송 이후 새 발화"를 모으려면 마지막 발송 시각(워터마크)이
필요하다. 이 테이블의 max(sent_at) 이 워터마크이자 발송 감사 로그.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p82_alert_digest"
down_revision: Union[str, None] = "p81_alert_unpublished_mounted"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "alert_digest_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("sent_at", sa.DateTime(), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("recipients", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("summary", postgresql.JSONB(), nullable=False, server_default="{}"),
    )
    op.create_index("ix_alert_digest_runs_sent", "alert_digest_runs", ["sent_at"])


def downgrade() -> None:
    op.drop_index("ix_alert_digest_runs_sent", table_name="alert_digest_runs")
    op.drop_table("alert_digest_runs")
