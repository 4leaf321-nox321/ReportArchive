"""phase 18 — report_presets (시작 양식/프리셋)

템플릿은 구조만 정의하지만, 부서/용도별로 *내용이 채워진* 시작 양식이
필요하다. ReportPreset 은 특정 템플릿 버전에 바인딩되고 seed(JSONB)에
본문·태그·종류·엔티티·표시설정 스냅샷을 담아, 새 보고서를 빈 상태가 아닌
미리 채워진 상태로 시작할 수 있게 한다. 가시성은 templates 와 동일하게
owner_workspace_slugs(NULL=전사) 로 워크스페이스 트리 단위.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY, JSONB


revision: str = "p18_report_presets"
down_revision: Union[str, None] = "p17_composite_two_col_view"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "report_presets",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("template_id", sa.String(length=64), nullable=False),
        sa.Column("template_version", sa.Integer(), nullable=False),
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
        sa.ForeignKeyConstraint(
            ["template_id", "template_version"],
            ["templates.template_id", "templates.version"],
            name="fk_report_presets_template",
            ondelete="RESTRICT",
        ),
    )
    op.create_index(
        "ix_report_presets_template", "report_presets", ["template_id"]
    )
    op.create_index(
        "ix_report_presets_owner_workspaces",
        "report_presets",
        ["owner_workspace_slugs"],
    )


def downgrade() -> None:
    op.drop_index("ix_report_presets_owner_workspaces", table_name="report_presets")
    op.drop_index("ix_report_presets_template", table_name="report_presets")
    op.drop_table("report_presets")
