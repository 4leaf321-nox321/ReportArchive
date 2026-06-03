"""phase 22 — composite revision + composite_item_requests (안건 제출 큐)

종합보고 동시편집 대응:
  - composite_reports.revision: 낙관적 동시성 토큰(구조 편집 충돌 감지).
  - composite_item_requests: 보고서 → 종합보고 "안건 제출(신청)" 큐. owner 가
    승인하면 건별 append 로 안건이 된다(전량 교체 충돌 회피).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p22_composite_item_requests"
down_revision: Union[str, None] = "p21_composite_view_mode"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "composite_reports",
        sa.Column(
            "revision", sa.Integer(), nullable=False, server_default="1"
        ),
    )

    # create_type=False 로 create_table 의 *암묵적* 타입 생성을 막고, 아래에서
    # 명시적으로 한 번만 만든다(checkfirst 로 부분 재실행에도 안전).
    status_enum = postgresql.ENUM(
        "pending",
        "accepted",
        "rejected",
        "withdrawn",
        name="composite_item_request_status_enum",
        create_type=False,
    )
    status_enum.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "composite_item_requests",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "composite_id",
            sa.Integer(),
            sa.ForeignKey("composite_reports.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "ref_report_id",
            sa.Integer(),
            sa.ForeignKey("reports.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "requested_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "status",
            status_enum,
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "decided_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("decided_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index(
        "ix_composite_item_requests_composite",
        "composite_item_requests",
        ["composite_id"],
    )
    op.create_index(
        "ix_composite_item_requests_report",
        "composite_item_requests",
        ["ref_report_id"],
    )
    op.create_index(
        "ix_composite_item_requests_status",
        "composite_item_requests",
        ["status"],
    )
    # (composite, report) 당 pending 하나만 — 부분 유니크.
    op.create_index(
        "uq_composite_item_requests_pending",
        "composite_item_requests",
        ["composite_id", "ref_report_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_composite_item_requests_pending",
        table_name="composite_item_requests",
    )
    op.drop_index(
        "ix_composite_item_requests_status",
        table_name="composite_item_requests",
    )
    op.drop_index(
        "ix_composite_item_requests_report",
        table_name="composite_item_requests",
    )
    op.drop_index(
        "ix_composite_item_requests_composite",
        table_name="composite_item_requests",
    )
    op.drop_table("composite_item_requests")
    sa.Enum(name="composite_item_request_status_enum").drop(
        op.get_bind(), checkfirst=True
    )
    op.drop_column("composite_reports", "revision")
