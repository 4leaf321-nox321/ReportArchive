"""phase 79 — alert_schedule: 경보 규칙 주기 자동 실행 (Phase D 2단계)

alert_rules 에 스케줄 컬럼(커넥터 DataSource 와 동형)을 더해, systemd 스케줄러
tick 이 due 규칙을 run_alert_rule 잡으로 적재 → 워커가 실행하게 한다. 시드된 두
규칙을 일간(1440분) 자동 실행으로 켠다. 설계: docs/[미구현] Phase D_경보_설계.md §5.2.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p79_alert_schedule"
down_revision: Union[str, None] = "p78_alerts"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("alert_rules", sa.Column(
        "schedule_kind", sa.String(16), nullable=False, server_default="manual"))
    op.add_column("alert_rules", sa.Column(
        "interval_minutes", sa.Integer(), nullable=True))
    op.add_column("alert_rules", sa.Column(
        "next_run_at", sa.DateTime(), nullable=True))
    op.add_column("alert_rules", sa.Column(
        "last_run_at", sa.DateTime(), nullable=True))
    op.add_column("alert_rules", sa.Column(
        "last_status", sa.String(16), nullable=True))
    op.create_index("ix_alert_rules_due", "alert_rules",
                    ["schedule_kind", "next_run_at"])

    # 시드 규칙을 일간 자동 실행으로. next_run_at=now → 다음 tick 에 바로 due.
    op.execute(
        """
        UPDATE alert_rules
        SET schedule_kind='interval', interval_minutes=1440, next_run_at=now()
        WHERE schedule_kind='manual'
        """
    )


def downgrade() -> None:
    op.drop_index("ix_alert_rules_due", table_name="alert_rules")
    op.drop_column("alert_rules", "last_status")
    op.drop_column("alert_rules", "last_run_at")
    op.drop_column("alert_rules", "next_run_at")
    op.drop_column("alert_rules", "interval_minutes")
    op.drop_column("alert_rules", "schedule_kind")
