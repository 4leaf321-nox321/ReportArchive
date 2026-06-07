"""phase 27 — '작성자+게시판 매니저만 편집' 게시 정책 지원

enum 값 2개 추가:
  - grant_principal_type_enum += 'workspace_manager' (부서의 매니저만 — 편집)
  - mount_edit_policy_enum    += 'manager' (게시 정책 표시값)

ALTER TYPE ADD VALUE 는 트랜잭션 제약이 있어 autocommit 블록에서 실행한다.
enum 값은 제거할 수 없어 downgrade 는 no-op.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "p27_manager_edit_grant"
down_revision: Union[str, None] = "p26_folder_grants"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute(
            "ALTER TYPE grant_principal_type_enum "
            "ADD VALUE IF NOT EXISTS 'workspace_manager'"
        )
        op.execute(
            "ALTER TYPE mount_edit_policy_enum ADD VALUE IF NOT EXISTS 'manager'"
        )


def downgrade() -> None:
    # PostgreSQL 은 enum 값 제거를 지원하지 않는다 — no-op.
    pass
