"""phase 70 — 커넥터 계보(provenance): entity_provenance

동기화가 채운 객체의 출처를 추적한다. (객체, 소스) 당 한 행 — 여러 소스가 같은 객체를
다룰 수 있으므로 UNIQUE(entity_id, data_source_id). first_seen/last_seen/마지막 run 기록.
코어 테이블(entities)을 안 건드리는 별도 테이블(설계 §6 계보, 저장방식 A).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p70_entity_provenance"
down_revision: Union[str, None] = "p69_data_source_sync_state"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "entity_provenance",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "entity_id",
            sa.Integer(),
            sa.ForeignKey("entities.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "data_source_id",
            sa.Integer(),
            sa.ForeignKey("data_sources.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "last_sync_run_id",
            sa.Integer(),
            sa.ForeignKey("sync_runs.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "first_seen", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "last_seen", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint(
            "entity_id", "data_source_id", name="uq_entity_provenance"
        ),
    )
    op.create_index(
        "ix_entity_provenance_source", "entity_provenance", ["data_source_id"]
    )
    op.create_index(
        "ix_entity_provenance_entity", "entity_provenance", ["entity_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_entity_provenance_entity", table_name="entity_provenance")
    op.drop_index("ix_entity_provenance_source", table_name="entity_provenance")
    op.drop_table("entity_provenance")
