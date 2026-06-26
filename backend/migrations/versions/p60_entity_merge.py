"""phase 60 — 엔티티 머지 보조 (중복 통합, 엔티티머지보조_설계.md)

중복/동의어 엔티티 통합을 위한 두 테이블:
  - entity_merge_dismissals: "중복 아님"으로 기각한 쌍(negative list) → 재출현 차단.
  - entity_merges: 머지 감사 로그(누가·언제·뭘 합쳤나; src 는 삭제되므로 값 스냅샷).
머지 실행(merge_entities)·별칭/관계 이관은 기존 코드 재사용 — 탐지/검토 레이어만 추가.
pgvector 무관 → 단독 배포 가능.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p60_entity_merge"
down_revision: Union[str, None] = "p59_ai_feature_report_authoring"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 기각 쌍 — (low, high) 정규화로 (A,B)=(B,A) 중복 방지. 엔티티 삭제 시 CASCADE.
    op.create_table(
        "entity_merge_dismissals",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("type_id", sa.Integer(), nullable=False),
        sa.Column("entity_low_id", sa.Integer(), nullable=False),
        sa.Column("entity_high_id", sa.Integer(), nullable=False),
        sa.Column("dismissed_by_user_id", sa.Integer(), nullable=True),
        sa.Column(
            "dismissed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["type_id"], ["entity_types.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["entity_low_id"], ["entities.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["entity_high_id"], ["entities.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["dismissed_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.UniqueConstraint(
            "entity_low_id",
            "entity_high_id",
            name="uq_entity_merge_dismissals_pair",
        ),
    )
    op.create_index(
        "ix_entity_merge_dismissals_type",
        "entity_merge_dismissals",
        ["type_id"],
    )

    # 머지 감사 로그 — src 는 삭제되므로 값/코드/별칭을 스냅샷으로 보존.
    op.create_table(
        "entity_merges",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("type_id", sa.Integer(), nullable=True),
        sa.Column("src_entity_id", sa.Integer(), nullable=False),
        sa.Column("src_value", sa.Text(), nullable=False),
        sa.Column("src_code", sa.Text(), nullable=True),
        sa.Column("into_entity_id", sa.Integer(), nullable=True),
        sa.Column("into_value", sa.Text(), nullable=False),
        sa.Column(
            "absorbed_aliases",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "relinked_report_count", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("merged_by_user_id", sa.Integer(), nullable=True),
        sa.Column(
            "merged_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        # type/into 는 이후 또 머지/삭제될 수 있어 SET NULL — 이력은 스냅샷으로 유지.
        sa.ForeignKeyConstraint(
            ["type_id"], ["entity_types.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["into_entity_id"], ["entities.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["merged_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
    )
    op.create_index(
        "ix_entity_merges_type", "entity_merges", ["type_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_entity_merges_type", table_name="entity_merges")
    op.drop_table("entity_merges")
    op.drop_index(
        "ix_entity_merge_dismissals_type", table_name="entity_merge_dismissals"
    )
    op.drop_table("entity_merge_dismissals")
