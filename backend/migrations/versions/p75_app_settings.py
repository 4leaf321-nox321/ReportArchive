"""phase 75 — app_settings: 관리자 런타임 설정 override 테이블

`.env`(BaseSettings)를 기본값으로 두고, 관리자가 재시작 없이 바꾸는 override 를
저장한다. 노출 키는 코드의 store.REGISTRY 로 큐레이션(범용 KV 아님). 값은 JSON
스칼라(bool/int/float). 빈 테이블 = 전부 .env 기본값(무해).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p75_app_settings"
down_revision: Union[str, None] = "p74_chunk_entity_links"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "app_settings",
        sa.Column("key", sa.String(length=100), primary_key=True),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=False,
        ),
        sa.Column(
            "updated_by_user_id", sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_table("app_settings")
