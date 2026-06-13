"""TemplateMetric — 템플릿이 가리키는 "대시보드 수치 지표" 정의.

Phase 3B(Phase3_대시보드_설계.md). 템플릿 패밀리(template_id)에 매달리는
*가변* 정의 — 템플릿 schema 는 (template_id, version) 불변이라, 지표를 바꿀
때마다 새 버전을 찍지 않으려고 schema 바깥의 별도 테이블에 둔다(D6).

전역(D7/Q1): template_id 단위라 그 템플릿을 쓰는 모든 부서 대시보드에 동일
지표가 뜬다. 시스템 관리자만 정의/편집한다(부서별 표시 on/off 는 후속).

MVP 는 key_value 스칼라만(source_kind='key_value') — 보고서 1건당 숫자 1개.
서버가 `content[block_id][field_key]` 를 꺼내 기간·부서별로 agg 한다(3B-2).
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class TemplateMetric(Base):
    __tablename__ = "template_metrics"
    __table_args__ = (
        # 같은 (템플릿, 블록, 필드) 지표 중복 방지. field_key NULL 은 Postgres
        # 에서 서로 distinct 취급(블록 값 자체를 지표로 쓰는 미래 케이스 대비).
        UniqueConstraint(
            "template_id", "block_id", "field_key", name="uq_template_metric"
        ),
        # 대시보드/관리 조회: 한 템플릿의 지표들.
        Index("ix_template_metrics_template", "template_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # 템플릿 *패밀리*. templates.template_id 는 단독으론 PK 가 아니라(버전과 복합)
    # FK 를 걸지 않고 문자열로 보관 — 지표는 버전 횡단으로 적용된다.
    template_id: Mapped[str] = mapped_column(String(64), nullable=False)
    # 위젯 블록(템플릿 schema 의 안정 slug).
    block_id: Mapped[str] = mapped_column(String(64), nullable=False)
    # key_value 의 item key. (미래 table_column/chart_series 확장 대비 nullable)
    field_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 값을 읽는 방식. MVP='key_value'.
    source_kind: Mapped[str] = mapped_column(
        String(32), nullable=False, default="key_value", server_default="key_value"
    )
    # 보고서 간 집계 방식: sum | avg | min | max | count | last.
    agg: Mapped[str] = mapped_column(
        String(16), nullable=False, default="avg", server_default="avg"
    )
    # 표시명·단위(예: "최대 응력" / "MPa").
    label: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    unit: Mapped[str] = mapped_column(
        String(32), nullable=False, default="", server_default=""
    )
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    display_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
