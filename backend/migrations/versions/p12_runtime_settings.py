"""phase 12 — runtime_settings 테이블

관리자-서버 페이지에서 편집 가능한 튜닝 값 (uvicorn workers, DB pool
size 등) 의 보관 장소. .env 는 SIF 배포에서 read-only bind-mount 이라
앱이 직접 못 건드리므로 DB 행으로 둔다.

각 row 는 단순 key-value 한 쌍:
  - key   : 정해진 식별자 ('uvicorn_workers', 'db_pool_size' 등)
  - value : 문자열(앱 측에서 int 로 파싱)
  - updated_by_user_id : 누가 마지막으로 만졌는지 감사용

대부분의 값은 워커/엔진 초기화 시점에만 읽히므로 변경 후 *재시작* 이
필요하다 — 프론트엔드에서 "현재 실행 중 값 ≠ 저장된 값" 일 때 배지로
안내한다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p12_runtime_settings"
down_revision: Union[str, None] = "p11_composite_item_group_name"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "runtime_settings",
        sa.Column("key", sa.String(length=64), primary_key=True),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_table("runtime_settings")
