"""phase 28 — 비밀번호 분실 복구 (관리자 중개 + 최초 로그인 변경 강제)

추가:
  - users.must_change_password: 관리자가 임시 비번을 발급하면 true → 최초
    로그인 시 새 비번 설정을 강제(프론트), 변경 성공 시 false.
  - password_reset_requests: "비밀번호 찾기" 요청 큐. 사용자가 이메일로
    요청하면 pending 으로 쌓이고, 관리 트리 내 관리자가 본인 확인 후
    임시 비번을 발급하며 resolved 처리한다.

비파괴(추가형) 마이그레이션 — 기존 데이터는 건드리지 않는다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p28_password_reset"
down_revision: Union[str, None] = "p27_manager_edit_grant"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "must_change_password",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )

    status_enum = postgresql.ENUM(
        "pending",
        "resolved",
        "canceled",
        name="password_reset_request_status_enum",
        create_type=False,
    )
    status_enum.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "password_reset_requests",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        # 요청한 이메일(가입 여부와 무관하게 보관 — 열거 방지용 항상 접수).
        sa.Column("email", sa.String(length=255), nullable=False, index=True),
        # 매칭되는 계정이 있으면 연결(없으면 NULL). 계정 삭제 시 NULL 로.
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column(
            "status",
            status_enum,
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "resolved_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
    )
    # pending 요청 빠른 조회 + 같은 이메일 중복 pending 합치기용 인덱스.
    op.create_index(
        "ix_password_reset_requests_status",
        "password_reset_requests",
        ["status"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_password_reset_requests_status",
        table_name="password_reset_requests",
    )
    op.drop_table("password_reset_requests")
    op.drop_column("users", "must_change_password")
    postgresql.ENUM(
        name="password_reset_request_status_enum"
    ).drop(op.get_bind(), checkfirst=True)
