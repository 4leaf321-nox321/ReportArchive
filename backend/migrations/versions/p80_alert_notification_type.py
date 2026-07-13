"""phase 80 — notification_type_enum 에 'alert_firing' 추가 (Phase D 3a)

경보 규칙이 새로 발화하면 관리자에게 인앱 알림을 만든다 — 그 알림 타입.
ADD VALUE 는 PG 12+ 에서 트랜잭션 내 실행 가능(같은 트랜잭션에서 사용만 안 하면 됨).
⚠️ DB enum 라벨은 SQLAlchemy 관례상 멤버 '이름'(alert_firing) — '값'(alert.firing)이 아니다.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "p80_alert_notification_type"
down_revision: Union[str, None] = "p79_alert_schedule"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TYPE notification_type_enum ADD VALUE IF NOT EXISTS 'alert_firing'"
    )


def downgrade() -> None:
    # PG enum 값 제거는 지원 안 됨(값 하나 되돌리려 타입 재생성은 과함) — no-op.
    pass
