"""phase 86 — notification_type_enum 에 'saved_search_hit' 추가 (저장검색 구독 #2)

구독한 저장검색 필터에 새 보고서가 걸리면 소유자에게 인앱 알림을 만든다 — 그 알림 타입.
⚠️ DB enum 라벨은 SQLAlchemy 관례상 멤버 '이름'(saved_search_hit) — '값'(saved_search.hit)이 아니다.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "p86_saved_search_notif"
down_revision: Union[str, None] = "p85_saved_searches"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TYPE notification_type_enum ADD VALUE IF NOT EXISTS 'saved_search_hit'"
    )


def downgrade() -> None:
    # PG enum 값 제거는 지원 안 됨 — no-op.
    pass
