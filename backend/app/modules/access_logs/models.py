"""User access (login) history.

사용자가 언제·어디서 시스템에 접속(로그인/가입)했는지를 남기는 append-only
감사 로그. 로그인/가입 시도마다 한 줄씩 기록되고, 시스템 관리자만 조회한다.

실패한 로그인(미가입 이메일 포함)도 남겨 보안 관점의 이상 접속을 확인할 수
있게 한다 — 그래서 user_id 는 nullable 이고, 누가 시도했는지는 email 로 남는다.
계정이 삭제돼도 이력 자체는 보존하되 user_id 만 끊는다(ON DELETE SET NULL).
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class UserAccessLog(Base):
    __tablename__ = "user_access_logs"
    __table_args__ = (
        # 최신순 목록(기본 조회) — created_at 인덱스.
        Index("ix_user_access_logs_created", "created_at"),
        # 특정 사용자의 접속 이력 필터.
        Index("ix_user_access_logs_user_created", "user_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # 실패(미가입 이메일) 로그는 user_id 가 없을 수 있다. 계정 삭제 시엔
    # user_id 만 NULL 로 끊고 이력은 남긴다.
    user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # 시도한/접속한 이메일(소문자). user_id 가 NULL 이어도 식별용으로 남는다.
    email: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    # 'login' | 'signup'
    event: Mapped[str] = mapped_column(String(32), nullable=False, default="login")
    success: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # 클라이언트 IP(IPv6 대비 64). nginx 뒤면 X-Forwarded-For 첫 홉.
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
