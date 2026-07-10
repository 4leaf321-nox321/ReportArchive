"""AppSetting — 관리자가 런타임에 바꾸는 전역 설정 override.

`.env`(BaseSettings)는 **기본값**이고, 이 테이블에 행이 있으면 그 값이 우선한다
(store.get). 재시작 없이 관리자 UI 에서 바꾸며, 각 프로세스는 짧은 캐시(store) TTL
안에 반영한다. **노출 대상은 store.REGISTRY 로 큐레이션**된 키만(범용 KV 아님).
값은 JSON 스칼라로 저장(bool/int/float 를 타입 손실 없이).
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)  # JSON 인코딩 스칼라
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    updated_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
