"""phase 54 — 엔티티 관계/계층(entity_relations)

평면 독립 축(모델·부품·BOM …)을 연결한다. 우선 `part_of` 한 종류 — 자식이
부모에 속함(부품 part_of 모델, BOM part_of 부품). M:N 그래프라 한 부품이 여러
모델에 속하는 현실도 수용(엔티티관리개선_설계.md §3.2).

이걸로 잠금 해제: 캐스케이드 picker(모델 선택 → 부품 좁힘, ?related_to=),
자동 제안, 롤업 대시보드(직접태그 ∪ 자식태그).

방향 규약: src --part_of--> dst (src=자식, dst=부모). relation 은 String 으로
두어 향후 종류 확장(supersedes 등)에 마이그레이션이 필요 없게 한다.

완전 additive — 새 테이블만 추가, 비어서 시작(관계 없음 = 현행 평면 동작).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p54_entity_relations"
down_revision: Union[str, None] = "p53_entity_governance"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "entity_relations",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("src_entity_id", sa.Integer(), nullable=False),
        sa.Column("dst_entity_id", sa.Integer(), nullable=False),
        sa.Column(
            "relation",
            sa.String(length=32),
            nullable=False,
            server_default="part_of",
        ),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["src_entity_id"], ["entities.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["dst_entity_id"], ["entities.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.UniqueConstraint(
            "src_entity_id",
            "dst_entity_id",
            "relation",
            name="uq_entity_relations",
        ),
    )
    # dst 기준 역방향("이 부모의 자식들" = 캐스케이드/롤업 핫패스).
    op.create_index(
        "ix_entity_relations_dst",
        "entity_relations",
        ["dst_entity_id", "relation"],
    )
    # src 기준("이 자식의 부모들").
    op.create_index(
        "ix_entity_relations_src",
        "entity_relations",
        ["src_entity_id", "relation"],
    )


def downgrade() -> None:
    op.drop_index("ix_entity_relations_src", table_name="entity_relations")
    op.drop_index("ix_entity_relations_dst", table_name="entity_relations")
    op.drop_table("entity_relations")
