"""Job ORM — 큐의 단일 백본 테이블.

notifications 와 같은 철학: 작업 *종류*마다 새 테이블을 만들지 않는다.
한 `jobs` 테이블에 type(핸들러 키) + payload(JSONB) 로 모든 종류를 담고,
처리 코드는 registry 의 핸들러로 분기한다.

시각 컬럼은 의도적으로 timezone-aware(`timestamptz`) — claim 쿼리가
`run_after <= now()` 로 서버 시각과 비교하므로, 레거시 naive datetime
(notifications) 과 섞이면 TZ 오프셋 버그가 난다. 이 테이블은 항상 aware
(`datetime.now(timezone.utc)`) 또는 SQL `now()` 만 쓴다.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


# 상태 값 — DB enum 대신 String 으로(마이그레이션 단순, 값 추가 자유).
STATUS_PENDING = "pending"
STATUS_RUNNING = "running"
STATUS_DONE = "done"
STATUS_FAILED = "failed"
STATUS_CANCELED = "canceled"

# 처리 중(running) 으로 갇혔다고 reaper 가 회수하는 기본 임계(초).
DEFAULT_REAP_TIMEOUT_S = 900


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (
        # claim 핫패스: 대기 중인 것 중 우선순위 높고 오래된 것 먼저.
        Index(
            "ix_jobs_claim",
            "priority",
            "run_after",
            "id",
            postgresql_where=text("status = 'pending'"),
        ),
        # reaper: 죽은 워커가 'running' 으로 남긴 좀비 회수.
        Index(
            "ix_jobs_running",
            "locked_at",
            postgresql_where=text("status = 'running'"),
        ),
        # 같은 (type, dedup_key) 가 동시에 두 번 쌓이지 않게.
        Index(
            "uq_jobs_dedup",
            "type",
            "dedup_key",
            unique=True,
            postgresql_where=text(
                "dedup_key IS NOT NULL AND status IN ('pending','running')"
            ),
        ),
        # "내 작업" 목록.
        Index("ix_jobs_created_by", "created_by", "created_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)

    # 핸들러 키 (registry.JOB_HANDLERS 의 키). 예: "export_pptx".
    type: Mapped[str] = mapped_column(String(64), nullable=False)

    # 핸들러 입력 인자. 스키마 강제는 핸들러 코드에서(여기선 자유 JSONB).
    payload: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default="{}", nullable=False
    )

    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=STATUS_PENDING,
        server_default=STATUS_PENDING,
    )
    # 높을수록 먼저 처리.
    priority: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    max_attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, default=5, server_default="5"
    )
    # 이 시각 이후에만 claim 가능 — 지연 실행 / 지수 백오프 재시도용.
    run_after: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    # 선택: 중복 enqueue 방지 키 (uq_jobs_dedup 참조).
    dedup_key: Mapped[str | None] = mapped_column(String(128), nullable=True)

    # 산출물/결과 참조. 예: {"file_id": "..."} → 사용자가 다운로드.
    result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # 워커가 집은 시각 + 식별자 (reaper 가 좀비 판별에 사용).
    locked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    worker_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # 누가 요청했나 — "내 작업" 조회/권한. 사용자 삭제돼도 작업은 남김.
    # ORM 레벨 FK 는 일부러 걸지 않는다 — Job 매퍼가 users 매퍼(및 그 관계
    # 체인)에 의존하면, jobs 모델만 import 하는 독립 워커 프로세스에서
    # 플러시 시 NoReferencedTableError 가 난다. 참조 무결성(SET NULL)은
    # 마이그레이션의 DB 레벨 ForeignKeyConstraint 가 보장한다(p47_jobs).
    created_by: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
