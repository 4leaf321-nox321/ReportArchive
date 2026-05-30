"""phase 14 — report_link_kinds 테이블

코드 상수로 박혀 있던 link 종류 (참조, 후속) 를 DB 행으로 옮긴다.
admin 페이지에서 새 유형 추가/라벨·색 편집/삭제가 가능해진다.

seed:
  - reference : 참조 / 참조됨  · blue
  - successor : 후속 / 선행    · green
두 row 는 ``system_locked=True`` — admin UI 에서 라벨/색은 바꿀 수 있지만
key 변경·row 삭제는 불가 (기존 데이터와의 호환성 유지).

report_links.kind 와는 FK 를 걸지 않는다 — cascade 가 복잡해지고,
"사용 중인 kind 삭제" 정책은 서비스 레이어에서 더 표현력 있게 다룰 수
있다 (409 + 사용 보고서 수 같이 안내).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p14_report_link_kinds"
down_revision: Union[str, None] = "p13_report_links"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "report_link_kinds",
        sa.Column("key", sa.String(length=32), primary_key=True),
        sa.Column("forward_label", sa.String(length=40), nullable=False),
        sa.Column("reverse_label", sa.String(length=40), nullable=False),
        # 화이트리스트 (blue / green / purple / amber / slate / rose / sky 등)
        # 은 서비스 레이어 검증 — Tailwind 클래스가 정적으로 purge 되어야
        # 하므로 임의 hex 는 허용 안 함.
        sa.Column("color", sa.String(length=16), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "system_locked",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
    )
    # seed — 기존 코드 상수와 정확히 일치하는 두 항목.
    op.execute(
        """
        INSERT INTO report_link_kinds
          (key, forward_label, reverse_label, color, sort_order, system_locked)
        VALUES
          ('reference', '참조', '참조됨', 'blue',  1, true),
          ('successor', '후속', '선행',  'green', 2, true)
        """
    )


def downgrade() -> None:
    op.drop_table("report_link_kinds")
