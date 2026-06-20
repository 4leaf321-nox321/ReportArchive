"""phase 48 — RAG 발판: report_chunks(보고서 청크 + 임베딩)

pgvector 확장 + 보고서 본문 청크/임베딩 저장 테이블 + HNSW(코사인) ANN 인덱스.
신규 테이블만 생성 — 기존 데이터/스키마 변경 없음(additive). 설계: 백그라운드워커_설계.md
의 "향후 확장(AI)" / 약점보강 로드맵의 RAG.

⚠️ 선결: 호스트 Postgres 에 pgvector OS 패키지가 깔려 있어야 한다
   (sudo apt-get install postgresql-16-pgvector). 아래 CREATE EXTENSION 이 그걸 켠다.
⚠️ 벡터 차원(1024)은 config.embedding_dim / 실제 임베딩 모델과 *반드시* 일치.
   모델이 다른 차원이면(예: E5-base=768) 여기 1024 와 config 를 함께 바꿀 것.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from pgvector.sqlalchemy import Vector


revision: str = "p48_report_chunks"
down_revision: Union[str, None] = "p47_jobs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_DIM = 1024  # config.embedding_dim 과 일치. 모델 변경 시 동반 수정.


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.create_table(
        "report_chunks",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("report_id", sa.Integer(), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("page_idx", sa.Integer(), nullable=True),
        sa.Column("block_id", sa.String(length=64), nullable=True),
        sa.Column("widget_type", sa.String(length=40), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("embedding", Vector(_DIM), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["report_id"], ["reports.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_report_chunks_report", "report_chunks", ["report_id"])
    op.create_index(
        "ix_report_chunks_report_hash", "report_chunks", ["report_id", "content_hash"]
    )
    # 벡터 ANN — HNSW + 코사인. 임베딩을 L2 정규화해 넣으므로 코사인=내적이지만,
    # 정규화 누락에도 견고하도록 코사인 연산자 클래스로.
    op.execute(
        "CREATE INDEX ix_report_chunks_embedding_hnsw "
        "ON report_chunks USING hnsw (embedding vector_cosine_ops)"
    )


def downgrade() -> None:
    op.drop_index("ix_report_chunks_embedding_hnsw", table_name="report_chunks")
    op.drop_index("ix_report_chunks_report_hash", table_name="report_chunks")
    op.drop_index("ix_report_chunks_report", table_name="report_chunks")
    op.drop_table("report_chunks")
    # vector 확장은 다른 데서 안 쓰면 남겨둔다(다른 테이블이 의존할 수 있어 drop 안 함).
