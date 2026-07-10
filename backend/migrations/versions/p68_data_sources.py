"""phase 68 — 외부 시스템 연계 커넥터 v1 (data_sources, sync_runs)

외부 REST/JSON API 를 데이터소스로 등록해 주기적으로(또는 수동으로) 데이터를 가져와
온톨로지(entities/relations)를 채운다. 가져온 레코드를 "평평한 rows" 로 변환해 기존
import_service.run_import 으로 upsert — 쓰기 로직 재사용(신규 0).

  - data_sources: 소스 등록(접속·매핑·스케줄). 매핑/인증은 config JSONB 에.
  - sync_runs:    동기화 실행 이력(건수·오류·트리거).

스케줄러(next_run_at 스캔)는 v2. 이 마이그레이션은 스키마만 — 스케줄 컬럼은 미리 두되
v1 은 수동 트리거만 쓴다(schedule_kind 기본 'manual').
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p68_data_sources"
down_revision: Union[str, None] = "p67_object_links"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "data_sources",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column(
            "kind", sa.String(length=32), nullable=False, server_default="rest_json"
        ),
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        # 접속(base_url·auth·headers) + fetch(records_path) + 매핑(축·값·속성·관계).
        sa.Column("config", postgresql.JSONB(), nullable=False, server_default="{}"),
        # 스케줄(v2) — 미리 둠. v1 은 'manual' 만.
        sa.Column(
            "schedule_kind",
            sa.String(length=16),
            nullable=False,
            server_default="manual",
        ),
        sa.Column("interval_minutes", sa.Integer(), nullable=True),
        sa.Column("next_run_at", sa.DateTime(), nullable=True),
        sa.Column("last_run_at", sa.DateTime(), nullable=True),
        sa.Column("last_status", sa.String(length=16), nullable=True),
        sa.Column(
            "created_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("name", name="uq_data_sources_name"),
    )

    op.create_table(
        "sync_runs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "source_id",
            sa.Integer(),
            sa.ForeignKey("data_sources.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "status", sa.String(length=16), nullable=False, server_default="running"
        ),
        sa.Column(
            "triggered_by",
            sa.String(length=16),
            nullable=False,
            server_default="manual",
        ),
        sa.Column("summary", postgresql.JSONB(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "started_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_sync_runs_source", "sync_runs", ["source_id", "started_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_sync_runs_source", table_name="sync_runs")
    op.drop_table("sync_runs")
    op.drop_table("data_sources")
