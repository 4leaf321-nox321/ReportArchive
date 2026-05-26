"""phase 8 — role enum admin → manager 일괄 rename (혼동 제거)

p7 에서 UI 라벨만 '관리자/부서 관리자' → '매니저' 로 통일했는데, DB·코드
에서는 여전히 'admin' 으로 저장되고 있어 헷갈림(workspace admin role vs
User.is_system_admin)이 남아 있었음. 데이터 의미는 그대로 두고 이름만
manager 로 정렬:

  - role_enum 의 'admin' 값 → 'manager' (Postgres 는 enum value 직접
    drop 이 까다로워 enum 자체를 재생성 + 컬럼 재캐스트)
  - 'manager' 값은 p7 마이그레이션이 user 로 강등 처리해서 row 가 없음.
    enum 에서 깔끔히 제거.

이 마이그레이션이 끝나면 role_enum 은 ('manager', 'user') 두 값만 남고,
기존 admin row 는 자동으로 manager 로 보임. Backfill 데이터 손실 없음.

Revision ID: p8_role_rename_admin_to_manager
Revises: p7_role_manager_to_user
Create Date: 2026-05-27
"""
from typing import Sequence, Union

from alembic import op


revision: str = "p8_role_rename_admin_to_manager"
down_revision: Union[str, None] = "p7_role_manager_to_user"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. 새 enum 생성. 최종 형태가 (manager, user).
    op.execute("CREATE TYPE role_enum_new AS ENUM ('manager', 'user')")
    # 2. 컬럼을 임시로 text 로 캐스트해 값 변환 여지 확보.
    op.execute("ALTER TABLE workspace_members ALTER COLUMN role TYPE text USING role::text")
    # 3. admin → manager. (manager 는 p7 에서 user 로 갔지만, 혹시 남은
    #    행이 있으면 user 로. 'admin'/'manager'/'user' 외 값이 끼어 있을
    #    가능성에 대비해 그 외 모든 값을 user 로 정규화.)
    op.execute("UPDATE workspace_members SET role='manager' WHERE role='admin'")
    op.execute("UPDATE workspace_members SET role='user' WHERE role NOT IN ('manager', 'user')")
    # 4. 새 enum 으로 컬럼 타입 변경.
    op.execute(
        "ALTER TABLE workspace_members ALTER COLUMN role TYPE role_enum_new "
        "USING role::role_enum_new"
    )
    # 5. 옛 enum 삭제.
    op.execute("DROP TYPE role_enum")
    # 6. 새 enum 이름을 role_enum 으로 (SQLAlchemy Enum(name='role_enum') 유지).
    op.execute("ALTER TYPE role_enum_new RENAME TO role_enum")


def downgrade() -> None:
    # 역방향: manager → admin 으로 되돌리고 enum 도 3값 복원.
    op.execute("CREATE TYPE role_enum_old AS ENUM ('admin', 'manager', 'user')")
    op.execute("ALTER TABLE workspace_members ALTER COLUMN role TYPE text USING role::text")
    # manager → admin (rename 되돌림). user 는 그대로.
    op.execute("UPDATE workspace_members SET role='admin' WHERE role='manager'")
    op.execute(
        "ALTER TABLE workspace_members ALTER COLUMN role TYPE role_enum_old "
        "USING role::role_enum_old"
    )
    op.execute("DROP TYPE role_enum")
    op.execute("ALTER TYPE role_enum_old RENAME TO role_enum")
