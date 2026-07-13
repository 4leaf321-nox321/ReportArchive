"""경보 ORM — AlertRule(규칙) + AlertRuleState(발화 상태).

Phase D 1단계. 조건은 내장 프로브 키(probe_key) + 파라미터(params JSONB)로 표현한다
(object_search 조건은 Phase B 데이터 이후). 발화 상태는 (rule, target) 별로 저장해
재실행 시 신규 진입만 발화하고 이탈은 해소 처리한다 — 스팸 방지의 핵심.
설계: docs/[미구현] Phase D_경보_설계.md.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class AlertRule(Base):
    """경보 규칙. 1단계는 프로브 조건만 + 수동 실행(주기 스캔·알림은 후속)."""

    __tablename__ = "alert_rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    probe_key: Mapped[str] = mapped_column(String(64), nullable=False)
    params: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    severity: Mapped[str] = mapped_column(String(16), nullable=False, default="info")
    # 스케줄(커넥터 DataSource 와 동형) — 'manual'=수동만, 'interval'=주기 자동.
    schedule_kind: Mapped[str] = mapped_column(
        String(16), nullable=False, default="manual"
    )
    interval_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AlertRuleState(Base):
    """(규칙, 대상) 별 발화 상태. state='firing' 이면 현재 걸린 것,
    'resolved' 면 이전에 걸렸다가 조건에서 벗어난 것. context 는 발화 시점
    스냅샷(제목·부서 등)으로 인박스가 재조회 없이 렌더한다."""

    __tablename__ = "alert_rule_state"

    rule_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("alert_rules.id", ondelete="CASCADE"), primary_key=True
    )
    target_type: Mapped[str] = mapped_column(String(32), primary_key=True)
    target_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    state: Mapped[str] = mapped_column(String(16), nullable=False)
    context: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    first_fired_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_notified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AlertDigestRun(Base):
    """이메일 다이제스트 발송 이력 — max(sent_at)=워터마크(그 이후 새 발화만 모음).
    Phase D 3b. summary={groups:[{rule_id,name,count}], total}."""

    __tablename__ = "alert_digest_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sent_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    recipients: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    summary: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
