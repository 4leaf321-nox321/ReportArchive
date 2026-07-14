"""phase 85 — saved_searches: 저장된 검색(스마트 폴더) + 구독

필터 조합(검색어·모드·날짜/종류/작성자/단계/엔티티)을 이름 붙여 저장 → 라이브 결과.
구독(subscribed) 컬럼은 후속 '필터 구독 → 알림/다이제스트'(#2)가 스케줄러로 새 보고서를
감지할 때 쓴다(now 구현은 CRUD/적용까지). watermark 이후 created_at 보고서 = 새 것.
설계: AI검색_지능화_로드맵 (B) 후속 arc(저장→구독).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p85_saved_searches"
down_revision: Union[str, None] = "p84_ai_conversations"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "saved_searches",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("query", sa.Text(), nullable=False, server_default=""),
        sa.Column("mode", sa.String(16), nullable=False, server_default="keyword"),
        # 필터 객체(프론트 appendReportFilters 모양 + entityIds/year/location/board).
        sa.Column("filters", postgresql.JSONB(), nullable=False, server_default="{}"),
        # 구독(#2) — 새 보고서 감지 알림.
        sa.Column("subscribed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("notify_channel", sa.String(16), nullable=False,
                  server_default="inapp"),
        sa.Column("last_notified_at", sa.DateTime(timezone=True), nullable=True),
        # 이 시각 이후 created_at 인 보고서를 '새 것'으로 본다(구독 감지 워터마크).
        sa.Column("seen_watermark", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_saved_searches_user", "saved_searches", ["user_id", "name"])
    # 스케줄러가 구독분만 빠르게 훑도록 partial index.
    op.create_index(
        "ix_saved_searches_subscribed", "saved_searches", ["subscribed"],
        postgresql_where=sa.text("subscribed"),
    )


def downgrade() -> None:
    op.drop_index("ix_saved_searches_subscribed", table_name="saved_searches")
    op.drop_index("ix_saved_searches_user", table_name="saved_searches")
    op.drop_table("saved_searches")
