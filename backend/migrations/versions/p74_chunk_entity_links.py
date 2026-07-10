"""phase 74 — 청크↔객체 링크: report_chunks.entity_ids

각 청크(내용 조각)가 언급하는 온톨로지 객체(entities) id 목록. 임베딩 시 결정적
경계매칭(autotag 재사용)으로 채운다. GraphRAG/검색이 "객체 이웃의 정확한 구절"을
문단 단위로 끌어오는 데 쓴다(스팬 단위 청크↔객체 결합).

기존 청크는 entity_ids='{}' 로 시작 — reindex_embeddings 재임베딩 시 채워진다(백필).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p74_chunk_entity_links"
down_revision: Union[str, None] = "p73_led_by_label"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "report_chunks",
        sa.Column(
            "entity_ids",
            postgresql.ARRAY(sa.Integer()),
            nullable=False,
            server_default="{}",
        ),
    )
    # 객체 → 그 객체를 언급한 청크 조회(entity_ids @> ARRAY[id]) GIN 인덱스.
    op.create_index(
        "ix_report_chunks_entity_ids",
        "report_chunks",
        ["entity_ids"],
        postgresql_using="gin",
    )


def downgrade() -> None:
    op.drop_index("ix_report_chunks_entity_ids", table_name="report_chunks")
    op.drop_column("report_chunks", "entity_ids")
