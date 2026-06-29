"""phase 62 — 워커 하트비트 (작업 큐 운영 가시성)

워커 프로세스가 살아있는지 관리자 화면에서 보여주기 위한 경량 테이블.
워커 메인 루프가 주기적으로 last_seen 을 갱신(upsert)하고, 헬스 조회는
"최근 N초 내 갱신된 워커가 있나"로 생존을 판정한다. 다중 워커 대비 worker_id
별 1행. 운영 가시성(잡 큐 탭)에서만 쓰며 처리 경로엔 영향 없음.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p62_worker_heartbeats"
down_revision: Union[str, None] = "p61_report_heading_numbering"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "worker_heartbeats",
        # worker_id = "{nodename}:{pid}" — 프로세스 단위 식별자.
        sa.Column("worker_id", sa.String(length=128), primary_key=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "last_seen",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        # concurrency·poll 등 진단용 부가 정보(자유 형식).
        sa.Column(
            "meta",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.create_index(
        "ix_worker_heartbeats_last_seen", "worker_heartbeats", ["last_seen"]
    )


def downgrade() -> None:
    op.drop_index(
        "ix_worker_heartbeats_last_seen", table_name="worker_heartbeats"
    )
    op.drop_table("worker_heartbeats")
