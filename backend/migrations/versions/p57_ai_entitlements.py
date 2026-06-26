"""phase 57 — B300 보조 AI 접근 제어(엔티틀먼트)

선별 유저/조직만 B300 기능(rag_qa·auto_summary)을 쓰게 하는 grant 테이블
(B300_보조AI_설계.md §E). 기본 deny — 행이 없으면 권한 없음. 가시성(grants)과
다른 축이라 별도 테이블. pgvector 무관 → 단독 배포 가능.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p57_ai_entitlements"
down_revision: Union[str, None] = "p56_entity_temporal"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# create_type=False — 아래에서 한 번만 명시적으로 만든다(create_table 이 중복
# 생성하지 않도록). p53 패턴.
feature_enum = postgresql.ENUM(
    "rag_qa", "auto_summary", "all", name="ai_feature_enum", create_type=False
)
subject_kind_enum = postgresql.ENUM(
    "user", "workspace", name="ai_subject_kind_enum", create_type=False
)


def upgrade() -> None:
    bind = op.get_bind()
    feature_enum.create(bind, checkfirst=True)
    subject_kind_enum.create(bind, checkfirst=True)

    op.create_table(
        "ai_entitlements",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("feature", feature_enum, nullable=False),
        sa.Column("subject_kind", subject_kind_enum, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("workspace_slug", sa.String(length=255), nullable=True),
        sa.Column(
            "include_descendants",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["workspace_slug"], ["workspaces.slug"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.UniqueConstraint(
            "feature",
            "subject_kind",
            "user_id",
            "workspace_slug",
            name="uq_ai_entitlements_subject",
        ),
    )
    op.create_index(
        "ix_ai_entitlements_user", "ai_entitlements", ["user_id"]
    )
    op.create_index(
        "ix_ai_entitlements_workspace", "ai_entitlements", ["workspace_slug"]
    )


def downgrade() -> None:
    op.drop_index("ix_ai_entitlements_workspace", table_name="ai_entitlements")
    op.drop_index("ix_ai_entitlements_user", table_name="ai_entitlements")
    op.drop_table("ai_entitlements")
    subject_kind_enum.drop(op.get_bind(), checkfirst=True)
    feature_enum.drop(op.get_bind(), checkfirst=True)
