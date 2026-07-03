"""phase 63 — 셀프 비밀번호 재설정 토큰 (메일러 Phase 3)

이메일로 보낸 재설정 링크의 토큰을 검증하기 위한 테이블. 원문 토큰은 저장하지
않고 sha256 해시만 둔다(PersonalAccessToken 과 같은 패턴). 만료·1회용.
메일 발송 불가 환경에선 기존 관리자 중개(password_reset_requests)로 폴백하므로
이 테이블이 비어 있어도 무방하다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p63_password_reset_tokens"
down_revision: Union[str, None] = "p62_worker_heartbeats"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "password_reset_tokens",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_password_reset_tokens_user_id", "password_reset_tokens", ["user_id"]
    )
    op.create_index(
        "ix_password_reset_tokens_token_hash",
        "password_reset_tokens",
        ["token_hash"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_password_reset_tokens_token_hash", table_name="password_reset_tokens"
    )
    op.drop_index(
        "ix_password_reset_tokens_user_id", table_name="password_reset_tokens"
    )
    op.drop_table("password_reset_tokens")
