"""phase 38 — report_versions (보고서 수정 이력·되돌리기)

보고서 본문 과거 스냅샷을 담는 콜드 테이블. 본문은 gzip 한 JSON 을 BYTEA 로
저장하고, 메타(작성자·시각·revision·해시·바이트수)만 컬럼으로. 핫 reports 와 분리,
보고서 삭제 시 CASCADE.

테이블만 추가(백필 없음) — 과거 이력은 소급 생성하지 않고, 적용 후 저장부터 쌓인다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p38_report_versions"
down_revision: Union[str, None] = "p37_report_search_text"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "report_versions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "report_id",
            sa.Integer(),
            sa.ForeignKey("reports.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column(
            "author_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("source", sa.String(16), nullable=False, server_default="save"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("body_gzip", sa.LargeBinary(), nullable=False),
        sa.Column("body_sha256", sa.String(64), nullable=False),
        sa.Column("body_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("label", sa.String(120), nullable=True),
        sa.Column(
            "is_pinned", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.UniqueConstraint("report_id", "seq", name="uq_report_versions_report_seq"),
    )
    op.create_index(
        "ix_report_versions_report_created",
        "report_versions",
        ["report_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_report_versions_report_created", table_name="report_versions")
    op.drop_table("report_versions")
