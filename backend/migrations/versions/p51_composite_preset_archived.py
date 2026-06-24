"""phase 51 — 종합보고 양식(CompositePreset) 보관(아카이브)

템플릿 보관(p50)과 동일하게 종합보고 양식에도 보관 상태를 추가한다. 보관하면
작성 picker·기본 목록에서 숨고 "보관" 분류로만 모인다. 행은 살아 있어 그 양식으로
이미 만든 종합보고에는 영향 없다(애초에 instantiate 후 독립).

완전 additive — 기존 행은 archived_at=NULL(=활성).

  * composite_presets.archived_at
  * composite_presets.archived_by_user_id (user 삭제 시 SET NULL)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p51_composite_preset_archived"
down_revision: Union[str, None] = "p50_template_archived"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "composite_presets",
        sa.Column("archived_at", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "composite_presets",
        sa.Column("archived_by_user_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_composite_presets_archived_at", "composite_presets", ["archived_at"]
    )
    op.create_foreign_key(
        "fk_composite_presets_archived_by_user",
        "composite_presets",
        "users",
        ["archived_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_composite_presets_archived_by_user",
        "composite_presets",
        type_="foreignkey",
    )
    op.drop_index(
        "ix_composite_presets_archived_at", table_name="composite_presets"
    )
    op.drop_column("composite_presets", "archived_by_user_id")
    op.drop_column("composite_presets", "archived_at")
