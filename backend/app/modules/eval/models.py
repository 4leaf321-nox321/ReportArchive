"""EvalCase — RAG 검색 평가 골든셋(관리자 UI 로 편집).

CLI(scripts/eval_rag.py)의 JSON 골든셋을 DB 로 옮겨, AI 설정 "평가" 탭에서
질문·정답 보고서를 관리하고 버튼으로 평가를 돌린다. report_id 는 배포별이라
이 서버 데이터로 채운다(app/ai/eval.py 가 지표 계산).
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class EvalCase(Base):
    __tablename__ = "eval_cases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    query: Mapped[str] = mapped_column(Text, nullable=False)
    # 정답 보고서 id(관련 근거). 배포별.
    expect_report_ids: Mapped[list[int]] = mapped_column(
        ARRAY(Integer), nullable=False, server_default="{}"
    )
    # (선택) 질문이 다뤄야 할 씨앗 객체 값 — 질문→씨앗 링킹 평가.
    expect_entities: Mapped[list[str]] = mapped_column(
        ARRAY(String), nullable=False, server_default="{}"
    )
    graph: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
