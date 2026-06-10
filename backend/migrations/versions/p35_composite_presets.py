"""phase 35 — composite_presets (종합보고 양식)

종합보고도 매 회차 요약 위젯 구성·그룹 골격·보기 모드가 거의 동일하게
반복된다. CompositePreset 은 그 세 가지(+설명)를 seed(JSONB)에 스냅샷으로
담아, 새 종합보고를 빈 상태가 아닌 미리 채워진 골격으로 시작할 수 있게
한다. 안건(item refs)은 회차마다 다르므로 담지 않는다. 보고서 프리셋과
달리 템플릿 바인딩이 없다(종합보고는 템플릿 schema 에 묶이지 않음).
가시성은 report_presets 와 동일하게 owner_workspace_slugs(NULL=전사).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY, JSONB


revision: str = "p35_composite_presets"
down_revision: Union[str, None] = "p34_summary_label_short"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "composite_presets",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("source_kind", sa.String(length=16), nullable=True),
        sa.Column("owner_workspace_slugs", ARRAY(sa.String(length=64)), nullable=True),
        sa.Column("seed", JSONB(), nullable=False, server_default="{}"),
        sa.Column(
            "created_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index(
        "ix_composite_presets_owner_workspaces",
        "composite_presets",
        ["owner_workspace_slugs"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_composite_presets_owner_workspaces", table_name="composite_presets"
    )
    op.drop_table("composite_presets")
