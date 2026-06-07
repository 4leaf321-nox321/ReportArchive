"""통합 공유(권한) 모델 — `ContentGrant`.

보고서·종합보고 공통의 단일 권한/가시성 출처(권한개편 계획). 기존의
mount 트리 가시성·external_view·ReportEditor·MountEditPolicy 를 하나의
grant 로 흡수한다.

한 grant = (콘텐츠, 대상, 권한레벨):
  - content_type/content_id : 어떤 콘텐츠인가(report | composite). 두 테이블을
    가리키므로 DB FK 는 걸지 않고 (content_type, content_id) 인덱스로만 묶는다.
  - principal_type/principal_ref : 누구에게인가.
      workspace → principal_ref = 부서 slug (하위 상속: 그 부서 + 하위 부서)
      user      → principal_ref = user_id(문자열)
      all_org   → principal_ref = NULL (사내 전 인증 사용자, view 전용)
  - level : view | edit. all_org 는 항상 view.

가시성/편집 판정은 grants/services.py 의 can_view / can_edit 가 담당.
"""
from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class GrantContentType(str, enum.Enum):
    report = "report"
    composite = "composite"


class GrantPrincipalType(str, enum.Enum):
    workspace = "workspace"  # 부서 slug — 하위 상속
    all_org = "all_org"      # 사내 전체(view 전용)
    user = "user"            # 개인
    # 부서의 *매니저만* — principal_ref=부서 slug. 게시 "작성자+게시판 매니저"
    # 정책에서 매니저 편집권에 쓴다(편집 전용 의미).
    workspace_manager = "workspace_manager"


class GrantLevel(str, enum.Enum):
    view = "view"
    edit = "edit"


class ContentGrant(Base):
    __tablename__ = "content_grants"
    __table_args__ = (
        # 비-NULL principal_ref(workspace/user) 중복 방지. all_org(ref NULL)는
        # PG 가 NULL 을 distinct 로 보므로 이 제약으론 안 묶임 → 마이그레이션에서
        # 부분 unique index 로 따로 보장.
        UniqueConstraint(
            "content_type",
            "content_id",
            "principal_type",
            "principal_ref",
            name="uq_content_grant_target",
        ),
        Index("ix_content_grants_content", "content_type", "content_id"),
        Index("ix_content_grants_principal", "principal_type", "principal_ref"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    content_type: Mapped[GrantContentType] = mapped_column(
        Enum(GrantContentType, name="grant_content_type_enum"), nullable=False
    )
    content_id: Mapped[int] = mapped_column(Integer, nullable=False)

    principal_type: Mapped[GrantPrincipalType] = mapped_column(
        Enum(GrantPrincipalType, name="grant_principal_type_enum"), nullable=False
    )
    # workspace_slug | user_id(문자열) | NULL(all_org)
    principal_ref: Mapped[str | None] = mapped_column(String(64), nullable=True)

    level: Mapped[GrantLevel] = mapped_column(
        Enum(GrantLevel, name="grant_level_enum"), nullable=False
    )

    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )


class FolderGrant(Base):
    """폴더(게시판 내 org 폴더) 통째 공유. 폴더 F 를 부서/전체/개인에 공유하면
    F 에 게시(mount.folder_id=F)된 보고서가 그 대상에게 보인다. BoardGrant 와
    동형이되 게시판보다 좁은 단위(폴더). 종합보고는 폴더가 없어 무관."""

    __tablename__ = "folder_grants"
    __table_args__ = (
        UniqueConstraint(
            "folder_id",
            "principal_type",
            "principal_ref",
            name="uq_folder_grant_target",
        ),
        Index("ix_folder_grants_folder", "folder_id"),
        Index("ix_folder_grants_principal", "principal_type", "principal_ref"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    folder_id: Mapped[int] = mapped_column(
        ForeignKey("folders.id", ondelete="CASCADE"), nullable=False
    )
    principal_type: Mapped[GrantPrincipalType] = mapped_column(
        Enum(GrantPrincipalType, name="grant_principal_type_enum"), nullable=False
    )
    principal_ref: Mapped[str | None] = mapped_column(String(64), nullable=True)
    level: Mapped[GrantLevel] = mapped_column(
        Enum(GrantLevel, name="grant_level_enum"), nullable=False
    )
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )


class BoardGrant(Base):
    """게시판(워크스페이스) 통째 공유. 게시판 B 를 부서/전체/개인에 공유하면
    B 에 게시(mount)된 보고서·B 가 home 인 종합보고가 그 대상에게 보인다.

    ContentGrant 와 같은 principal/level 의미(부서는 하위 상속, all_org 는 view
    전용). 콘텐츠별 공유 위에 '게시판 단위' 한 겹을 더한 것 — 가시성 판정은
    grants/services 가 콘텐츠 grant ∪ 그 콘텐츠의 board grant 로 합친다.
    """

    __tablename__ = "board_grants"
    __table_args__ = (
        UniqueConstraint(
            "board_slug",
            "principal_type",
            "principal_ref",
            name="uq_board_grant_target",
        ),
        Index("ix_board_grants_board", "board_slug"),
        Index("ix_board_grants_principal", "principal_type", "principal_ref"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    board_slug: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("workspaces.slug", ondelete="CASCADE"),
        nullable=False,
    )
    principal_type: Mapped[GrantPrincipalType] = mapped_column(
        Enum(GrantPrincipalType, name="grant_principal_type_enum"), nullable=False
    )
    principal_ref: Mapped[str | None] = mapped_column(String(64), nullable=True)
    level: Mapped[GrantLevel] = mapped_column(
        Enum(GrantLevel, name="grant_level_enum"), nullable=False
    )
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
