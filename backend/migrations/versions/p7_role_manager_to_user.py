"""phase 7 — role 단계 정리 (manager → user 강등)

부서 멤버의 3단계(관리자/매니저/사용자) 중 '매니저' 라는 중간 단계를
없애기로 결정. 정리 정책:
  - 기존 관리자/부서 관리자 → 라벨만 '매니저'로 변경 (프론트에서 처리)
  - 기존 매니저 → '사용자'로 강등 (템플릿/폴더 권한 회수). 이 권한이
    필요하면 admin 이 다시 새 '매니저'(=기존 admin role) 로 임명.
  - 일반 사용자 → 그대로.

DB 차원에서는 workspace_members.role 컬럼 값만 손댄다. role_enum
postgres type 자체에서 'manager' 값을 제거하지는 않는다 — enum value
drop 은 Postgres 에서 까다롭고, 일단 더 이상 row 가 쓰지 않으면 무해.
필요할 때 별도 마이그레이션으로 정리.

Revision ID: p7_role_manager_to_user
Revises: p6_user_home_workspace
Create Date: 2026-05-27
"""
from typing import Sequence, Union

from alembic import op


revision: str = "p7_role_manager_to_user"
down_revision: Union[str, None] = "p6_user_home_workspace"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # manager → user. 권한이 줄어드는 강등이라 admin 이 운영상 다시
    # 임명할 필요가 있다면 별도로 처리. 데이터 손실은 없음 (role 컬럼만).
    op.execute(
        "UPDATE workspace_members SET role = 'user' WHERE role = 'manager'"
    )


def downgrade() -> None:
    # 강등이 된 user 들 중 어느 row 가 원래 manager 였는지 식별할 수 없으므로
    # 진정한 복원은 불가능. downgrade 는 no-op — 운영자가 백업에서 복원해야.
    pass
