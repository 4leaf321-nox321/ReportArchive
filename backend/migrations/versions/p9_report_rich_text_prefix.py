"""phase 9 — reports.page_rich_text_prefix

긴 글(rich_text) 위젯의 depth-0 대표 문장 머리 기호를 보고서마다 따로
지정할 수 있게 하는 컬럼. 기본 글리프는 `■` 인데, 부서/문서 종류에 따라
선호 기호가 다르다는 피드백을 받아 보고서별 override 를 둔다.

  - NULL  → 시스템 기본(`■`) 사용
  - 문자열 → 그 문자열을 depth-0 마커로 사용 (에디터·DOCX·종합보고 일관)

길이는 8자로 컷 — 짧은 기호 + 공백 + 짧은 텍스트 정도까지 허용하면서도
누군가 본문 길이를 넣는 사고는 막는다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p9_report_rich_text_prefix"
down_revision: Union[str, None] = "p8_role_rename_admin_to_manager"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "reports",
        sa.Column("page_rich_text_prefix", sa.String(length=8), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("reports", "page_rich_text_prefix")
