"""phase 30 — report_takedown_requests (게시판별 게시취소 요청 큐)

보고서 삭제 재설계 2단계. 작성자가 "게시판에서 내리기"를 요청하면 게시된
부서 게시판마다 한 건씩 pending 으로 쌓이고(팬아웃), 각 게시판 매니저가 자기
board 건만 승인(게시취소)/거절(게시 유지)한다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p30_report_takedown_requests"
down_revision: Union[str, None] = "p29_report_soft_delete"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "report_takedown_requests",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("report_id", sa.Integer(), nullable=False),
        sa.Column("workspace_slug", sa.String(length=64), nullable=False),
        sa.Column("requested_by_user_id", sa.Integer(), nullable=True),
        sa.Column(
            "status",
            sa.Enum(
                "pending",
                "approved",
                "rejected",
                "canceled",
                name="takedown_status_enum",
            ),
            server_default="pending",
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("decided_by_user_id", sa.Integer(), nullable=True),
        sa.Column("decided_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["report_id"], ["reports.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["workspace_slug"], ["workspaces.slug"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["requested_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["decided_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
    )
    op.create_index(
        "ix_takedown_workspace_status",
        "report_takedown_requests",
        ["workspace_slug", "status"],
    )
    op.create_index(
        "ix_takedown_report", "report_takedown_requests", ["report_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_takedown_report", table_name="report_takedown_requests")
    op.drop_index(
        "ix_takedown_workspace_status", table_name="report_takedown_requests"
    )
    op.drop_table("report_takedown_requests")
    sa.Enum(name="takedown_status_enum").drop(op.get_bind(), checkfirst=True)
