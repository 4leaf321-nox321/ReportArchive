"""phase 16 — 조직 간 공개(cross-org external view) 컬럼

조직간공개_설계.md §4. 게시판·폴더 단위로 "다른 조직 조회 허용" 을 옵트인한다.

  - workspaces.external_view_default : 이 게시판에 게시된 보고서를 다른 조직이
    조회 가능한가 (org 게시판에만 의미, 폴더가 override 가능). 기존 행 = false.
  - folders.external_view : 폴더별 3-state override
    (NULL=게시판 기본 상속 / TRUE=공개 / FALSE=비공개). org 폴더에만 의미.

둘 다 기존 행은 false / NULL 로 남으므로 = 현행 완전 격리 유지(무동작 디폴트).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p16_cross_org_external_view"
down_revision: Union[str, None] = "p15_html_embed_bundles"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "workspaces",
        sa.Column(
            "external_view_default",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "folders",
        sa.Column(
            "external_view",
            sa.Boolean(),
            nullable=True,
            server_default=None,
        ),
    )


def downgrade() -> None:
    op.drop_column("folders", "external_view")
    op.drop_column("workspaces", "external_view_default")
