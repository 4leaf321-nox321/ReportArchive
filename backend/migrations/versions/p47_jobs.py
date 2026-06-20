"""phase 47 — 백그라운드 작업 큐(jobs)

웹 요청 경로에서 떼어낼 무거운/지연 가능 작업을 적재하는 단일 큐 테이블.
별도 워커 프로세스(worker.py)가 SELECT … FOR UPDATE SKIP LOCKED 로 꺼내 처리.
신규 테이블만 생성 — 기존 데이터/스키마 변경 없음(완전 additive).

시각 컬럼은 timestamptz(timezone=True) — claim 의 `run_after <= now()` 비교가
서버 시각과 일관되도록(레거시 naive datetime 과 섞지 않음). 설계: 백그라운드워커_설계.md.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p47_jobs"
down_revision: Union[str, None] = "p46_composite_default_grant"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "jobs",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("type", sa.String(length=64), nullable=False),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "status", sa.String(length=16), nullable=False, server_default="pending"
        ),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="5"),
        sa.Column(
            "run_after",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("dedup_key", sa.String(length=128), nullable=True),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("worker_id", sa.String(length=64), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
    )
    # claim 핫패스: 대기 작업 중 우선순위/시각 순.
    op.create_index(
        "ix_jobs_claim",
        "jobs",
        ["priority", "run_after", "id"],
        postgresql_where=sa.text("status = 'pending'"),
    )
    # reaper: 좀비(running) 회수.
    op.create_index(
        "ix_jobs_running",
        "jobs",
        ["locked_at"],
        postgresql_where=sa.text("status = 'running'"),
    )
    # 중복 enqueue 방지: 같은 (type, dedup_key) 가 pending/running 에 둘 이상 없게.
    op.create_index(
        "uq_jobs_dedup",
        "jobs",
        ["type", "dedup_key"],
        unique=True,
        postgresql_where=sa.text(
            "dedup_key IS NOT NULL AND status IN ('pending','running')"
        ),
    )
    # "내 작업" 조회.
    op.create_index("ix_jobs_created_by", "jobs", ["created_by", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_jobs_created_by", table_name="jobs")
    op.drop_index("uq_jobs_dedup", table_name="jobs")
    op.drop_index("ix_jobs_running", table_name="jobs")
    op.drop_index("ix_jobs_claim", table_name="jobs")
    op.drop_table("jobs")
