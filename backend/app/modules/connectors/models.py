"""커넥터 ORM — DataSource(등록) + SyncRun(실행 이력).

접속·매핑은 `DataSource.config`(JSONB)에 담는다 — 컬럼 폭증을 피하고 소스 종류마다
다른 필드를 유연하게 수용. config 스키마는 schemas.SourceConfig 참조.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class DataSource(Base):
    """외부 데이터소스 등록. config 에 접속(base_url·auth)·fetch(records_path)·
    매핑(축·값·속성·관계)이 들어간다. 스케줄 컬럼은 v2 스케줄러용(v1=manual)."""

    __tablename__ = "data_sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    kind: Mapped[str] = mapped_column(
        String(32), nullable=False, default="rest_json"
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # 증분(watermark) 런타임 상태 — 스트림별 마지막 커서 {'<stream idx>': '<value>'}.
    # config(정의)와 분리(편집이 커서를 날리지 않게).
    sync_state: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)

    schedule_kind: Mapped[str] = mapped_column(
        String(16), nullable=False, default="manual"
    )
    interval_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_status: Mapped[str | None] = mapped_column(String(16), nullable=True)

    created_by_user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )


class SyncRun(Base):
    """동기화 1회 실행 이력. summary 는 run_import 의 카운트(create/update/error…)."""

    __tablename__ = "sync_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("data_sources.id", ondelete="CASCADE"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="running"
    )
    triggered_by: Mapped[str] = mapped_column(
        String(16), nullable=False, default="manual"
    )
    summary: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by_user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
