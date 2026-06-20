"""report_chunks — 보고서 본문 청크 + 임베딩(RAG/시맨틱 검색의 저장소).

한 보고서는 여러 청크(블록/페이지/제목 단위)로 쪼개져 각자 임베딩을 갖는다.
청크 단위는 app/widgets/text_extraction.py 의 TextChunk 를 그대로 재사용한다
(위치 메타 report_id/page_idx/block_id 가 RAG 인용·위젯 점프에 쓰임).

가시성(권한) 필터는 reports 와 조인해 처리하므로 여기엔 workspace/deleted_at 을
중복 저장하지 않는다. 보고서 하드삭제 시 FK CASCADE 로 청크도 제거되고,
재임베딩 시 핸들러가 해당 report_id 청크를 지우고 새로 넣는다.
"""
from __future__ import annotations

from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.config import settings
from app.database import Base


class ReportChunk(Base):
    __tablename__ = "report_chunks"
    __table_args__ = (
        # 보고서 단위 조회/삭제·재임베딩(replace) 핫패스.
        Index("ix_report_chunks_report", "report_id"),
        # content_hash 로 변경 없는 보고서의 재임베딩 스킵 판단.
        Index("ix_report_chunks_report_hash", "report_id", "content_hash"),
        # 벡터 ANN 인덱스(HNSW, 코사인)는 마이그레이션에서 직접 생성
        # (op.execute) — pgvector 전용 인덱스라 여기 Index() 로는 표현 안 함.
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)

    # 보고서 하드삭제 시 청크도 함께 제거(소프트삭제는 reports.deleted_at 으로
    # 조인 시점에 필터).
    report_id: Mapped[int] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"), nullable=False
    )

    # 보고서 내 청크 순서(0부터). 인용·정렬용.
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # 위치 메타(TextChunk 그대로). page_idx/block_id 가 None 이면 제목·페이지명 등.
    page_idx: Mapped[int | None] = mapped_column(Integer, nullable=True)
    block_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    widget_type: Mapped[str | None] = mapped_column(String(40), nullable=True)

    # 청크 평문 + 임베딩 벡터.
    text: Mapped[str] = mapped_column(Text, nullable=False)
    # 차원은 settings.embedding_dim 과 마이그레이션의 Vector(N) 가 일치해야 함.
    embedding: Mapped[list[float]] = mapped_column(
        Vector(settings.embedding_dim), nullable=False
    )

    # 보고서 본문 해시(재임베딩 스킵 판단용 — 같은 해시면 다시 안 만듦).
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
