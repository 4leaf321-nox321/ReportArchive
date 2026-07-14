"""Saved searches (스마트 폴더) — 사용자별 필터 조합 저장 + 구독.

검색어·모드·필터(날짜/종류/작성자/단계/엔티티/연도)를 이름 붙여 저장하면, 열 때마다
그 조건으로 **라이브** 결과를 다시 뜬다(결과 스냅샷이 아님 — 조건만 저장). `subscribed`
면 스케줄러가 주기적으로 그 조건을 돌려 `seen_watermark` 이후 생성된 새 보고서를 감지해
알림/다이제스트를 보낸다(#2). 필터 스키마는 프론트 appendReportFilters 와 1:1 —
{dateField,lastDays,period,dateFrom,dateTo,reportTypeIds,authorIds,editorIds,phases,
lifecycles,tags,entityIds,entityRollup,year,location,board}. 각 사용자 소유(공유 없음).
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
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class SavedSearch(Base):
    __tablename__ = "saved_searches"
    __table_args__ = (
        Index("ix_saved_searches_user", "user_id", "name"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    query: Mapped[str] = mapped_column(Text, default="", server_default="", nullable=False)
    # 'keyword' | 'semantic' — 저장 당시 검색 모드(적용 시 복원).
    mode: Mapped[str] = mapped_column(
        String(16), default="keyword", server_default="keyword", nullable=False
    )
    filters: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default="{}", nullable=False
    )

    # ── 구독(#2) — 새 보고서 감지 알림 ──────────────────────────────────
    subscribed: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    # 'inapp' | 'email' | 'both'
    notify_channel: Mapped[str] = mapped_column(
        String(16), default="inapp", server_default="inapp", nullable=False
    )
    last_notified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # 이 시각 이후 created_at 인 보고서를 '새 것'으로 본다(구독 감지 워터마크).
    seen_watermark: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(),
        nullable=False,
    )
