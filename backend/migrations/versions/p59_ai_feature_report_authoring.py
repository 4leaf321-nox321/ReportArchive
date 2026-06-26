"""phase 59 — AI 기능 enum 에 report_authoring 추가 (local LLM 보고서 작성)

ai_feature_enum 에 새 값 'report_authoring' 추가. ADD VALUE 는 PG 12+ 에서
트랜잭션 내 실행 가능(같은 트랜잭션에서 그 값을 사용만 안 하면 됨). IF NOT EXISTS
로 멱등.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "p59_ai_feature_report_authoring"
down_revision: Union[str, None] = "p58_report_ai_summaries"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TYPE ai_feature_enum ADD VALUE IF NOT EXISTS 'report_authoring'"
    )


def downgrade() -> None:
    # Postgres enum 값 제거는 비표준(타입 재생성 필요) — 무위. 값이 남아도 무해.
    pass
