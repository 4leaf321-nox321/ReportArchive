"""phase 20 — reports.collab_workspace_slugs (협업 부서)

보고서의 "관련 정보"에 함께 일한 조직(부서)을 등록한다. 기준정보(엔티티)와
달리 별도 등록 없이 시스템에 이미 등록된 부서 트리(workspaces)를 직접 참조하는
워크스페이스 슬러그 배열. 작성 부서(workspace_slug)·게시 부서(mounts)와는 다른
의미(함께 일한 조직). 기존 행은 {}(빈 배열).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY


revision: str = "p20_report_collab_workspaces"
down_revision: Union[str, None] = "p19_composite_summary_widgets"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "reports",
        sa.Column(
            "collab_workspace_slugs",
            ARRAY(sa.String()),
            nullable=False,
            server_default="{}",
        ),
    )


def downgrade() -> None:
    op.drop_column("reports", "collab_workspace_slugs")
