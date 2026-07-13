"""phase 83 — alert_rules.notify_owner: 작성자 통보 옵트인 (Phase D 3c)

True 면 새로 발화한 보고서의 작성자(owner)에게도 인앱 알림. 기본 False —
일반 사용자 다수에게 가므로 관리자가 규칙별로 켤 때만.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p83_alert_notify_owner"
down_revision: Union[str, None] = "p82_alert_digest"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("alert_rules", sa.Column(
        "notify_owner", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("alert_rules", "notify_owner")
