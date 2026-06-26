"""phase 56 — 엔티티 시간 차원(축별 연도 정책 + 유효구간/연도 세트)

매년 값이 쌓이는 기준정보에서 "올해 관련"만 기본 노출하고 전체는 옵트인으로
보기 위한 토대(엔티티그래프_온톨로지_설계.md "시간 차원"). 세 가지를 추가한다:

  * entity_types.temporal_kind  evergreen|lifecycle|yearly|derived
      — 축마다 연도 적용 방식을 선언(모델=yearly, 부품=lifecycle/derived,
        시험=evergreen). 기존 7축은 evergreen 으로 시작 → 연도 필터 no-op =
        현행 동작 보존.
  * entities.valid_from_year / valid_to_year (nullable int)
      — lifecycle 축의 유효구간(도입~폐지). NULL 끝 = 개방.
  * entity_years (entity_id, year) 세트 테이블
      — yearly 축(모델)의 불연속 연도 배정.

완전 additive. derived 는 컬럼 없이 report_entities×reports.report_date 로 런타임
추론하므로 저장 스키마가 없다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p56_entity_temporal"
down_revision: Union[str, None] = "p55_relation_types"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# create_type=False — 아래에서 한 번만 명시적으로 만든다(add_column 이 중복
# 생성하지 않도록). p53 entry_policy_enum 과 같은 패턴.
temporal_kind_enum = postgresql.ENUM(
    "evergreen",
    "lifecycle",
    "yearly",
    "derived",
    name="entity_temporal_kind_enum",
    create_type=False,
)


def upgrade() -> None:
    bind = op.get_bind()
    temporal_kind_enum.create(bind, checkfirst=True)

    op.add_column(
        "entity_types",
        sa.Column(
            "temporal_kind",
            temporal_kind_enum,
            nullable=False,
            server_default="evergreen",
        ),
    )
    op.add_column(
        "entities",
        sa.Column("valid_from_year", sa.Integer(), nullable=True),
    )
    op.add_column(
        "entities",
        sa.Column("valid_to_year", sa.Integer(), nullable=True),
    )

    op.create_table(
        "entity_years",
        sa.Column("entity_id", sa.Integer(), nullable=False),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["entity_id"], ["entities.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("entity_id", "year"),
    )
    op.create_index("ix_entity_years_year", "entity_years", ["year"])


def downgrade() -> None:
    op.drop_index("ix_entity_years_year", table_name="entity_years")
    op.drop_table("entity_years")
    op.drop_column("entities", "valid_to_year")
    op.drop_column("entities", "valid_from_year")
    op.drop_column("entity_types", "temporal_kind")
    temporal_kind_enum.drop(op.get_bind(), checkfirst=True)
