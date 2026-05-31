"""phase 15 — html_embed_bundles 테이블

HTML 임베드의 폴더 번들 지원(HTML임베드_번들_설계.md). 메인 HTML + 서브 파일을
폴더 구조 그대로 디스크에 저장하고, 불투명 bundle_id(capability)로 sandbox
iframe 에 서빙한다. 파일 바이트는 {settings.embed_bundles_dir_path}/{id}/ 아래
보관하고, 이 테이블은 메타(엔트리 경로·파일 수·크기·소유자)만 갖는다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p15_html_embed_bundles"
down_revision: Union[str, None] = "p14_report_link_kinds"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "html_embed_bundles",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("entry_path", sa.String(length=512), nullable=False),
        sa.Column("file_count", sa.Integer(), nullable=False),
        sa.Column("total_bytes", sa.BigInteger(), nullable=False),
        sa.Column("owner_user_id", sa.Integer(), nullable=True),
        sa.Column("workspace_slug", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["workspace_slug"], ["workspaces.slug"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_embed_bundles_owner", "html_embed_bundles", ["owner_user_id"], unique=False
    )
    op.create_index(
        "ix_embed_bundles_workspace",
        "html_embed_bundles",
        ["workspace_slug"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_embed_bundles_workspace", table_name="html_embed_bundles")
    op.drop_index("ix_embed_bundles_owner", table_name="html_embed_bundles")
    op.drop_table("html_embed_bundles")
