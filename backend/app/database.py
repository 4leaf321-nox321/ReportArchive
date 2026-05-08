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


engine = create_engine(
    settings.database_url,
    echo=settings.sqlalchemy_echo,
    pool_pre_ping=True,
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
