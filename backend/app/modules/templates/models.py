"""Template models.

Templates are immutable per (template_id, version). Editing a template
publishes a new version; old versions remain so reports created against
them stay renderable.

Visibility model (hybrid sharing, multi-workspace):
  - owner_workspace_slugs = NULL or empty → global / 전사 (visible to all)
  - owner_workspace_slugs = ['dev']       → scoped to dev's tree
                                            (dev + descendants + ancestors)
  - owner_workspace_slugs = ['dev','biz'] → visible to either tree

The visibility filter is applied in the service layer using workspace
tree helpers — a template is visible if ANY of its owner slugs
intersects the actor's accessible tree.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    PrimaryKeyConstraint,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Template(Base):
    """Versioned template — composite PK (template_id, version)."""

    __tablename__ = "templates"
    __table_args__ = (
        PrimaryKeyConstraint("template_id", "version", name="pk_templates"),
        Index("ix_templates_owner_workspaces", "owner_workspace_slugs"),
        Index("ix_templates_template_id", "template_id"),
    )

    template_id: Mapped[str] = mapped_column(String(64), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    category: Mapped[str] = mapped_column(String(64), default="misc", nullable=False)

    # JSON Schema 2020-12 stored verbatim. Validated on insert (the document is
    # itself a JSON Schema, so we sanity-check it before saving).
    schema: Mapped[dict] = mapped_column(JSONB, nullable=False)

    # NULL or empty array = global / 전사.
    # Each slug refers to a row in `workspaces`. We don't FK to that table
    # at the array level (Postgres doesn't support per-element FK), so the
    # service layer is responsible for validating membership before insert.
    owner_workspace_slugs: Mapped[list[str] | None] = mapped_column(
        ARRAY(String(64)), nullable=True
    )

    is_published: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_latest: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # 보관(아카이브). set 되면 작성 picker·기본 목록에서 숨고 새 보고서 작성이
    # 막힌다. 단 by-id 렌더는 그대로라 기존 보고서는 계속 렌더된다(삭제와 달리
    # 행이 살아있음). template_id 단위 개념 — 보관 시 모든 버전 행에 set 한다.
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True, index=True
    )
    archived_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )


class TemplateEntityType(Base):
    """템플릿↔엔티티 축 바인딩 — "이 템플릿으로 작성할 때 어떤 축을 picker 로
    노출할지". 축을 켜고 끄는 것이지 값(entity)을 정하는 게 아니다(태그는
    report_entities 가 사실 데이터로 별도 유지).

    template_id 단위(버전 무관, 보관/공유와 같은 결). template_id 는 templates
    에서 유일하지 않아(버전마다 행) FK 를 걸지 않는다 — owner_workspace_slugs 와
    같은 이유로 서비스 레이어가 정합성을 책임진다. entity_type_id 만 FK.

    **빈 바인딩 = 전체 축**(서비스 레이어 규칙). 그래서 행이 없는 template_id 는
    모든 축을 노출 — backfill 없이도 현행 동작 보존.
    """

    __tablename__ = "template_entity_types"
    __table_args__ = (
        PrimaryKeyConstraint(
            "template_id", "entity_type_id", name="pk_template_entity_types"
        ),
        Index("ix_template_entity_types_type", "entity_type_id"),
    )

    template_id: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_type_id: Mapped[int] = mapped_column(
        ForeignKey("entity_types.id", ondelete="CASCADE"), nullable=False
    )
    # required=True 면 작성/저장 시 그 축 미태깅에 대해 soft 경고(과거 보고서 소급
    # 강제는 없음 — 새 저장에만 적용).
    required: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
