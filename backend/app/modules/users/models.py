"""User + workspace membership models.

Auth uses JWT (Bearer token) with bcrypt-hashed passwords.

Two orthogonal authorization concepts:

  * **시스템 관리자** (`User.is_system_admin`) — a global boolean.
    Grants access to system-wide actions: workspace tree CRUD,
    base data masters (categories, entities, report types, sections),
    server/admin pages. Set by another system admin or via seed.
    Independent of any workspace membership.

  * **부서 관리자** (`WorkspaceMember.role = admin`) — per-workspace.
    Grants management of THAT workspace's members + reports + folders.
    Multiple admins per workspace are allowed. Ancestor walk applies
    (admin at a parent workspace is admin in every descendant), so
    본부 관리자 = 산하 팀들의 관리자.

The two are intentionally separate so an org-wide IT operator
(시스템 관리자) doesn't double as everyone's 부서 관리자, and a
부서 관리자 of one team can't reorganize the whole org chart.

Roles in WorkspaceMember (3 levels):
    admin   — 부서 관리자 — manage that workspace's members + manager rights
    manager — write/edit/delete reports + create/edit templates
    user    — read reports
"""
from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Role(str, enum.Enum):
    admin = "admin"
    manager = "manager"
    user = "user"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # bcrypt hash. Nullable so seed users created before auth was wired up
    # don't crash; password-less users can't log in until an admin sets one.
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)
    # 시스템 관리자 flag — global; orthogonal to workspace memberships.
    # See module docstring. Defaults to false; only granted via seed or
    # by another system admin (no self-promotion UI).
    is_system_admin: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        server_default="false",
        nullable=False,
    )

    # 소속 부서 — signup 시 선택한 부서. 어느 부서에 속하는지는 이 한
    # 컬럼이 권위 있는 답이고, 그 외 추가 멤버십은 부서 멤버 페이지에서
    # 별도로 관리. NULL 가능 — admin 이 만든 신규 계정이 아직 어떤 부서
    # 도 지정 안 된 상태 또는 home 부서가 삭제된 사용자(ON DELETE SET
    # NULL). NULL 이면 사이드바·프로필 화면이 '소속 없음' 표시.
    home_workspace_slug: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("workspaces.slug", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    memberships: Mapped[list["WorkspaceMember"]] = relationship(
        "WorkspaceMember", back_populates="user", cascade="all, delete-orphan"
    )


class WorkspaceMember(Base):
    __tablename__ = "workspace_members"
    __table_args__ = (UniqueConstraint("user_id", "workspace_slug", name="uq_user_workspace"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    workspace_slug: Mapped[str] = mapped_column(
        ForeignKey("workspaces.slug", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[Role] = mapped_column(Enum(Role, name="role_enum"), nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    user: Mapped[User] = relationship("User", back_populates="memberships")
