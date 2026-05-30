"""phase 13 — report_links 테이블

보고서 간 의미 있는 연결. (from_report) → (to_report) 단방향으로 저장하고
kind 문자열로 관계 유형을 구분한다 (reference / successor / …). 새 유형은
코드 상수 (`app/shared/link_kinds.py`) 에 줄 추가만 하면 되며 DB 스키마는
그대로다 — 동적 admin UI 가 필요해지면 별도 link_kinds 테이블로 이주.

권한: link 추가/삭제는 from_report 의 편집 권한 보유자만 (can_edit).
조회는 보고서 read 권한과 동일.

cascade: 양 끝 report 가 삭제되면 link 도 함께 사라진다.

UNIQUE(from, to, kind) — 동일 보고서 쌍에 같은 종류 link 중복 금지.
같은 쌍에 다른 종류 link 는 허용 ("참조" + "후속" 동시).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p13_report_links"
down_revision: Union[str, None] = "p12_runtime_settings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "report_links",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "from_report_id",
            sa.Integer(),
            sa.ForeignKey("reports.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "to_report_id",
            sa.Integer(),
            sa.ForeignKey("reports.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("note", sa.String(length=200), nullable=True),
        sa.Column(
            "created_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "from_report_id",
            "to_report_id",
            "kind",
            name="uq_report_links_from_to_kind",
        ),
        # 한 보고서를 from 또는 to 로 양쪽 조회가 잦으므로 둘 다 인덱스.
        sa.Index("ix_report_links_from", "from_report_id"),
        sa.Index("ix_report_links_to", "to_report_id"),
    )


def downgrade() -> None:
    op.drop_table("report_links")
