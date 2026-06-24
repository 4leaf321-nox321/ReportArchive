"""phase 52 — 템플릿↔엔티티 축 바인딩(template_entity_types)

템플릿마다 "보고서 작성 시 어떤 엔티티 축을 picker 로 노출할지"를 정한다. 축(axis)을
켜고 끄는 것이지 값(entity)을 정하는 게 아니다 — 태그 자체는 report_entities 가 사실
데이터로 별도 유지된다.

수명주기 규칙(엔티티관리개선_설계.md §2.1):
  * **빈 바인딩 = 전체 기본** — 어떤 template_id 에 행이 하나도 없으면 7축 전체 노출.
    그래서 backfill 이 필요 없다 — 테이블은 비어서 시작하고 기존/신규 템플릿 모두 현행
    동작(전체 축)을 그대로 유지한다. 관리자가 템플릿별로 축을 골라 행을 넣으면 그때부터
    그 부분집합만 노출.
  * 축 삭제는 picker 숨김일 뿐, 이미 태깅된 보고서의 태그는 보존(편집 picker 는
    바인딩축 ∪ 보고서가 이미 가진 축 합집합).

template_id 단위(버전 무관) — 보관(p50)·공유와 같은 결.

완전 additive — 기존 데이터 무손상, 새 테이블만 추가.

  * template_entity_types(template_id, entity_type_id, required, sort_order)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p52_template_entity_types"
down_revision: Union[str, None] = "p51_composite_preset_archived"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "template_entity_types",
        sa.Column("template_id", sa.String(length=64), nullable=False),
        sa.Column("entity_type_id", sa.Integer(), nullable=False),
        sa.Column(
            "required",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column(
            "sort_order",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.ForeignKeyConstraint(
            ["entity_type_id"],
            ["entity_types.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "template_id", "entity_type_id", name="pk_template_entity_types"
        ),
    )
    # 역방향(축 삭제 시 CASCADE, "이 축을 쓰는 템플릿") 조회용. template_id 단방향
    # 조회는 PK 의 leftmost 가 커버한다.
    op.create_index(
        "ix_template_entity_types_type",
        "template_entity_types",
        ["entity_type_id"],
    )
    # 의도적으로 backfill 없음 — 빈 바인딩 = 전체 축(서비스 레이어 규칙).


def downgrade() -> None:
    op.drop_index(
        "ix_template_entity_types_type", table_name="template_entity_types"
    )
    op.drop_table("template_entity_types")
