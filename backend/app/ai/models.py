"""report_chunks — 보고서 본문 청크 + 임베딩(RAG/시맨틱 검색의 저장소).

한 보고서는 여러 청크(블록/페이지/제목 단위)로 쪼개져 각자 임베딩을 갖는다.
청크 단위는 app/widgets/text_extraction.py 의 TextChunk 를 그대로 재사용한다
(위치 메타 report_id/page_idx/block_id 가 RAG 인용·위젯 점프에 쓰임).

가시성(권한) 필터는 reports 와 조인해 처리하므로 여기엔 workspace/deleted_at 을
중복 저장하지 않는다. 보고서 하드삭제 시 FK CASCADE 로 청크도 제거되고,
재임베딩 시 핸들러가 해당 report_id 청크를 지우고 새로 넣는다.
"""
from __future__ import annotations

import enum
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.config import settings
from app.database import Base


class AiFeature(str, enum.Enum):
    """B300 보조 AI 기능 식별자. `all` = 모든 기능 와일드카드(grant 편의)."""

    rag_qa = "rag_qa"
    auto_summary = "auto_summary"
    all = "all"


class AiSubjectKind(str, enum.Enum):
    """엔티틀먼트 부여 대상 종류 — 개별 유저 또는 워크스페이스(조직)."""

    user = "user"
    workspace = "workspace"


class AiEntitlement(Base):
    """B300 기능 접근 권한 (E, B300_보조AI_설계.md). **기본 deny** — 시스템
    관리자가 명시적으로 허락한 유저/조직만 해당 기능을 쓴다(파일럿→점진 확대).

    가시성(grants)과 다른 축: "데이터를 누가 보나"가 아니라 "이 *기능*을 누가
    쓰나". `include_descendants`(기본 OFF)면 워크스페이스 트리 하위까지 적용 —
    상위→하위 자동 전파는 의도치 않은 노출의 단골이라 의식적으로 켜야 한다.
    끄기 = 행 삭제(감사는 created_by/created_at/note)."""

    __tablename__ = "ai_entitlements"
    __table_args__ = (
        UniqueConstraint(
            "feature",
            "subject_kind",
            "user_id",
            "workspace_slug",
            name="uq_ai_entitlements_subject",
        ),
        Index("ix_ai_entitlements_user", "user_id"),
        Index("ix_ai_entitlements_workspace", "workspace_slug"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    feature: Mapped[AiFeature] = mapped_column(
        Enum(AiFeature, name="ai_feature_enum"), nullable=False
    )
    subject_kind: Mapped[AiSubjectKind] = mapped_column(
        Enum(AiSubjectKind, name="ai_subject_kind_enum"), nullable=False
    )
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    workspace_slug: Mapped[str | None] = mapped_column(
        ForeignKey("workspaces.slug", ondelete="CASCADE"), nullable=True
    )
    include_descendants: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


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
