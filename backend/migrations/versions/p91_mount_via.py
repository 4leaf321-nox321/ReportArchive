"""phase 91 — 게시(mount)에 작성 경로(via) 표식

MCP 는 **사용자의 토큰으로** 동작한다. AI 가 올린 게시가 그 사람이 직접 올린
것과 구분되지 않으면, 잘못 올라간 게시의 경위를 추적할 수 없다.

`report_mounts.via`:
  - 'web' (기본) — 사람이 화면에서 게시
  - 'mcp'        — AI(MCP)가 사용자 권한으로 게시

`comments.via`(p90)·`report_versions.source='mcp'` 와 같은 목적이다. 서버가
요청 헤더(X-Client)를 보고 채우며 클라이언트 입력은 신뢰하지 않는다.

게시는 되돌리기 어려운 바깥 방향 행위(조직에 문서가 보이고, 내리려면 매니저
승인이 필요)라 MCP 경로는 **2단계 확인**(preview → confirm token)을 강제한다.
그 토큰은 서명 기반이라 별도 테이블이 없다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "p91_mount_via"
down_revision: Union[str, None] = "p90_comment_via"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "report_mounts",
        sa.Column("via", sa.String(length=16), nullable=False, server_default="web"),
    )


def downgrade() -> None:
    op.drop_column("report_mounts", "via")
