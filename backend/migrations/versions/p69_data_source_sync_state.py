"""phase 69 — 커넥터 증분 동기화 상태(data_sources.sync_state)

증분(watermark) 동기화용 런타임 상태. 스트림별 마지막 watermark 값을 담는다
(키='<stream index>'). config(정의)와 분리해 저장 — config 편집이 커서를 날리지 않게.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p69_data_source_sync_state"
down_revision: Union[str, None] = "p68_data_sources"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "data_sources",
        sa.Column("sync_state", postgresql.JSONB(), nullable=False,
                  server_default="{}"),
    )


def downgrade() -> None:
    op.drop_column("data_sources", "sync_state")
