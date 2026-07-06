"""phase 65 — 온톨로지 강화 A0.2 (링크 속성/근거, 순수 추가)

엔티티 간 링크(entity_relations)를 1급 관계로 살찌우는 층. **전부 additive**라
기존 관계 동작 무영향(온톨로지강화_설계.md §3.4):
  1. entity_relations.properties (JSONB DEFAULT '{}') — 링크 속성(예: 시험 일자·결과).
     relation_type 의 property_defs(owner_kind='relation_type')로 검증한다.
  2. entity_relations.evidence_report_id (FK→reports, SET NULL) — 이 링크를 주장한
     근거 보고서(provenance). 보고서가 지워지면 링크는 남고 근거만 NULL 로.
  3. entity_relations.evidence_note (VARCHAR) — 근거 자유 메모.

property_defs 테이블은 p64 에서 이미 폴리모픽(owner_kind)이라 재사용한다 —
새 테이블 없음. 되돌리기(downgrade)도 깨끗하게 되돌아간다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p65_link_properties_evidence"
down_revision: Union[str, None] = "p64_ontology_property_foundation"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. 링크 속성 — 기존 행은 전부 '{}'
    op.add_column(
        "entity_relations",
        sa.Column(
            "properties",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    # 2. 근거 보고서 — nullable, 보고서 삭제 시 SET NULL(링크 자체는 보존)
    op.add_column(
        "entity_relations",
        sa.Column("evidence_report_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_entity_relations_evidence_report",
        "entity_relations",
        "reports",
        ["evidence_report_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_entity_relations_evidence",
        "entity_relations",
        ["evidence_report_id"],
    )
    # 3. 근거 메모
    op.add_column(
        "entity_relations",
        sa.Column("evidence_note", sa.String(length=500), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("entity_relations", "evidence_note")
    op.drop_index("ix_entity_relations_evidence", table_name="entity_relations")
    op.drop_constraint(
        "fk_entity_relations_evidence_report",
        "entity_relations",
        type_="foreignkey",
    )
    op.drop_column("entity_relations", "evidence_report_id")
    op.drop_column("entity_relations", "properties")
