"""phase 92 — 종합보고 안건 요청에 작성 경로(via) 표식

안건 제출 요청은 **사람이 승인**하는 큐다. 그런데 MCP 는 사용자의 토큰으로
동작하므로, AI 가 낸 요청과 그 사람이 직접 낸 요청이 승인 화면에서 구분되지
않았다. 승인자가 판단할 근거가 하나 빠진 셈이다.

`composite_item_requests.via`:
  - 'web' (기본) — 사람이 화면에서 제출
  - 'mcp'        — AI(MCP)가 사용자 권한으로 제출

`comments.via`(p90)·`report_mounts.via`(p91)·`report_versions.source='mcp'` 와
같은 규약. 서버가 요청 헤더(X-Client)를 보고 채운다.

※ 기준정보 쓰기(create_object 등)에는 이 표식을 두지 않았다 — `entities`·별칭·
   링크가 이미 `created_by_user_id` 로 **누가** 만들었는지 남기고, 그 경로는
   시스템관리자 전용이라 "웹이냐 AI냐"의 실익이 3개 테이블 마이그레이션 비용을
   넘지 않는다고 판단했다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "p92_composite_request_via"
down_revision: Union[str, None] = "p91_mount_via"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "composite_item_requests",
        sa.Column("via", sa.String(length=16), nullable=False, server_default="web"),
    )


def downgrade() -> None:
    op.drop_column("composite_item_requests", "via")
