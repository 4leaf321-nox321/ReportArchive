"""phase 90 — 댓글에 작성 경로(via) 표식

MCP 는 **사용자의 토큰으로** 동작한다. 그래서 AI 가 남긴 답글이 그 사람이 직접
쓴 것처럼 보인다 — 표식이 없으면 "이 사람이 그렇게 답했다"고 오해하게 되어
협업 신뢰가 깨진다.

`comments.via` 로 작성 경로를 남긴다:
  - 'web' (기본) — 사람이 화면에서 작성
  - 'mcp'        — AI(MCP)가 사용자 권한으로 작성

보고서 본문의 `report_versions.source='mcp'` 와 같은 목적(감사 표식)이고,
그쪽은 컬럼이 이미 자유 문자열이라 마이그레이션이 필요 없었다. 댓글엔 그런
컬럼이 없어 여기서 만든다.

서버가 채우는 값이라 클라이언트 입력을 신뢰하지 않는다 — 백엔드가 요청
헤더(X-Client)를 보고 정한다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "p90_comment_via"
down_revision: Union[str, None] = "p89_mount_multi_folder"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "comments",
        sa.Column(
            "via",
            sa.String(length=16),
            nullable=False,
            server_default="web",
        ),
    )


def downgrade() -> None:
    op.drop_column("comments", "via")
