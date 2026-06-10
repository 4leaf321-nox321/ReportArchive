"""phase 36 — users.preferences (사용자별 UI/작성 환경설정)

사용자별 자유 JSON 설정 가방. 첫 용도는 위젯 "제목 생략"의 새-위젯 기본값을
위젯 종류별로 기억하는 것(widget_caption_skip_autofill). 본인 /api/me 응답에만
실린다. 기본값 빈 객체.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "p36_user_preferences"
down_revision: Union[str, None] = "p35_composite_presets"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "preferences",
            JSONB(),
            nullable=False,
            server_default="{}",
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "preferences")
