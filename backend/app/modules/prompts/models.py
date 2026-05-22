"""AI 프롬프트 — 사용자가 등록하는 보고서-생성용 프롬프트 카탈로그.

각 prompt row 는 본문(body) + 메타(name, description, settings) 로 구성되며,
보고서 종류와 똑같은 official/unofficial 패턴을 따른다 — 누구나 unofficial
로 작성하고, admin 이 official 로 승격해 모든 사용자에게 노출.

`settings` 는 향후 AI API 호출 시 사용할 model / temperature / system /
response_format 등을 담는 자유 JSON. 1차 구현에서는 저장만 하고 호출
연계는 Phase 4 에서 별도로 다룬다.
"""
from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.modules.users.models import User


class PromptStatus(str, enum.Enum):
    official = "official"
    unofficial = "unofficial"


class Prompt(Base):
    __tablename__ = "prompts"
    __table_args__ = (
        Index("ix_prompts_status", "status"),
        Index("ix_prompts_created_by", "created_by_user_id"),
        # Case-insensitive uniqueness is enforced at the service layer
        # via lower(name) lookups; the plain unique on name catches the
        # exact-match collisions and the lower() check picks up the rest.
        Index("uq_prompts_name", "name", unique=True),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # The actual prompt body, including placeholder tokens like
    # {{template_id}}, {{widget_catalog}}, {{widget:bulleted_list}}.
    # Renderer + token extractor live in app/modules/prompts/rendering.py.
    body: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[PromptStatus] = mapped_column(
        Enum(PromptStatus, name="prompt_status_enum"),
        default=PromptStatus.unofficial,
        nullable=False,
    )

    # Free-form JSON for future AI API integration (model id, temperature,
    # system prompt, response_format, etc.). Kept opaque at the DB layer
    # so we can evolve the shape without a migration.
    settings: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    approved_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_by: Mapped["User | None"] = relationship(
        "User", foreign_keys=[created_by_user_id], lazy="joined"
    )
    approved_by: Mapped["User | None"] = relationship(
        "User", foreign_keys=[approved_by_user_id], lazy="joined"
    )
