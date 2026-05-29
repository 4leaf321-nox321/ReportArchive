"""
Database engine, session factory and Base model.

Sync SQLAlchemy 2.0 + psycopg3. FastAPI dependency `get_db` yields a
scoped session and ensures it is closed even on exception.
"""
from __future__ import annotations

from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings
from app.shared.runtime_tuning import get_int as _tuning_get_int

# Pool 크기는 관리자-서버 UI 에서 편집 가능 (runtime_settings 테이블).
# 런타임 변경은 안 됨 — 엔진 생성 시점에 한 번만 읽힘. 사용자가 값을
# 바꿔도 운영자가 systemctl restart 로 워커를 재기동해야 적용된다.
# runtime_tuning.get_int 가 DB → env → default 순으로 fallback.
_POOL_SIZE = _tuning_get_int("db_pool_size")
_MAX_OVERFLOW = _tuning_get_int("db_max_overflow")

engine = create_engine(
    settings.database_url,
    echo=settings.sqlalchemy_echo,
    pool_pre_ping=True,
    pool_size=_POOL_SIZE,
    max_overflow=_MAX_OVERFLOW,
    future=True,
)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
    expire_on_commit=False,
    future=True,
)


class Base(DeclarativeBase):
    """Base class for all ORM models."""


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency that provides a transactional scope."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
