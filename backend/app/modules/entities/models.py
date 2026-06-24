"""Entity tagging — N-axis controlled vocabulary attached to reports.

A report can be tagged with multiple `Entity` rows across several
*axes* (`EntityType`). Examples of axes the seed migration installs:
모델명 / 부품명 / BOM Code / 개발 단계 / 불량 종류 / 신뢰성 시험 /
시뮬레이션 종류. Same shape as `report_types` (controlled vocab) but
many-per-report and split across axes.

Design choices:
- Two layers: `entity_types` (the axes — 7 seeded, system-managed) and
  `entities` (the values — admin curated but any logged-in user can add
  a value on-the-fly from the picker, status defaults to `active`).
- M:N link via `report_entities` (composite PK). Report.entities is a
  selectin relationship through that table.
- Case-insensitive uniqueness on (type_id, value) enforced at the
  service layer — same pattern report_types uses for `name`.
- No `workspace_slug` column yet — every value is org-wide. Will become
  nullable if a department ever needs a scoped vocabulary; the schema
  bump is a one-column migration.
"""
from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.modules.users.models import User


class EntityStatus(str, enum.Enum):
    """active = picker로 노출, deprecated = picker에서 숨기되 이미 태깅된
    보고서엔 그대로 유지. 강삭제는 별도 머지/삭제 엔드포인트로만."""

    active = "active"
    deprecated = "deprecated"


class EntityEntryPolicy(str, enum.Enum):
    """축의 입력 정책. open = 누구나 picker에서 새 값 추가(현행), closed =
    관리자가 등록한 값만 선택(사용자 즉석 추가 차단). 모델·BOM 같은 정형
    마스터 축을 잠그는 데 쓴다."""

    open = "open"
    closed = "closed"


class EntityType(Base):
    """An axis (e.g. 모델명, 부품명, BOM Code).

    The 7 axes are seeded by the migration and are not user-editable from
    the API — `slug` is the stable identifier the frontend keys off, and
    `label/icon/sort_order` are presentation-only metadata. If we ever
    need an 8th axis, we add it via migration; admin self-service for
    axis creation is intentionally deferred.

    `multi` is a render-time hint for the picker (single-select vs.
    multi-select). The DB does NOT enforce it — a report can technically
    hold multiple `phase` entities; we trust the picker UI to keep that
    invariant for axes that are conceptually single-valued.
    """

    __tablename__ = "entity_types"
    __table_args__ = (
        Index("uq_entity_types_slug", "slug", unique=True),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    slug: Mapped[str] = mapped_column(String(32), nullable=False)
    label: Mapped[str] = mapped_column(String(64), nullable=False)
    # Lucide icon name (frontend resolves). Stored as string so the
    # icon set can change without a migration.
    icon: Mapped[str] = mapped_column(String(32), default="", nullable=False)
    multi: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)

    # 입력 거버넌스 (p53). entry_policy=closed 면 사용자 즉석 추가 차단(관리자만),
    # value_pattern 이 있으면 새 값 생성 시 그 정규식(fullmatch)으로 형식 검증.
    # 기존 7축은 open·NULL 로 시작해 현행 동작 보존.
    entry_policy: Mapped[EntityEntryPolicy] = mapped_column(
        Enum(EntityEntryPolicy, name="entity_entry_policy_enum"),
        default=EntityEntryPolicy.open,
        nullable=False,
    )
    value_pattern: Mapped[str | None] = mapped_column(String(255), nullable=True)


class Entity(Base):
    """A single value within one axis (e.g. type=모델, value="A1234")."""

    __tablename__ = "entities"
    __table_args__ = (
        # Hot path: picker fetches by (type, status) and substring-searches
        # by value. The composite covers both filters; a separate value
        # index lets the GIN-like trigram extension be bolted on later
        # if substring search ever gets slow.
        Index("ix_entities_type_status", "type_id", "status"),
        Index("ix_entities_type_value", "type_id", "value"),
        Index("ix_entities_created_by", "created_by_user_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    type_id: Mapped[int] = mapped_column(
        ForeignKey("entity_types.id", ondelete="RESTRICT"), nullable=False
    )
    value: Mapped[str] = mapped_column(String(255), nullable=False)
    # Optional secondary identifier (e.g. ERP code for a 부품). Kept
    # informational — uniqueness is on `value`, not on `code`, because a
    # value can exist before its code is known.
    code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[EntityStatus] = mapped_column(
        Enum(EntityStatus, name="entity_status_enum"),
        default=EntityStatus.active,
        nullable=False,
    )

    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    entity_type: Mapped["EntityType"] = relationship(
        "EntityType", foreign_keys=[type_id], lazy="joined"
    )
    created_by: Mapped["User | None"] = relationship(
        "User", foreign_keys=[created_by_user_id], lazy="joined"
    )


class ReportEntity(Base):
    """M:N link between Report and Entity.

    Declared as a full ORM model (not just a Table) so future per-link
    columns (e.g. "added by", "added at", confidence from AI auto-tag)
    can land without a relationship rewrite. `Report.entities` uses
    `secondary="report_entities"` against this table.

    `entity_id` is RESTRICT so an in-use entity can't be hard-deleted;
    the deprecate flow is the soft-delete path. `report_id` cascades so
    deleting a report cleans up its links.
    """

    __tablename__ = "report_entities"

    report_id: Mapped[int] = mapped_column(
        ForeignKey("reports.id", ondelete="CASCADE"), primary_key=True
    )
    entity_id: Mapped[int] = mapped_column(
        ForeignKey("entities.id", ondelete="RESTRICT"), primary_key=True
    )
    # Reverse index so "show me reports tagged with entity X" stays cheap
    # — without it Postgres would scan the table to filter by entity_id.
    __table_args__ = (
        Index("ix_report_entities_entity", "entity_id"),
    )


class EntityAlias(Base):
    """같은 대상의 다른 표기 → canonical 엔티티 매핑 (p53).

    사용자가 별칭(예: `A-1234`)을 입력하면 서비스가 normalized(lower+trim)로
    조회해 canonical 엔티티(`A1234`)로 태깅한다 — 새 엔티티가 안 생기고,
    사후 merge 필요성이 사라진다.

    `type_id` 는 비정규화(=entity 의 축). (type_id, normalized) 유니크로 한 축
    안에서 같은 표기가 두 값에 매핑되는 것을 막는다. entity 삭제 시 CASCADE.
    """

    __tablename__ = "entity_aliases"
    __table_args__ = (
        UniqueConstraint(
            "type_id", "normalized", name="uq_entity_aliases_type_norm"
        ),
        Index("ix_entity_aliases_entity", "entity_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entity_id: Mapped[int] = mapped_column(
        ForeignKey("entities.id", ondelete="CASCADE"), nullable=False
    )
    type_id: Mapped[int] = mapped_column(
        ForeignKey("entity_types.id", ondelete="CASCADE"), nullable=False
    )
    alias: Mapped[str] = mapped_column(String(255), nullable=False)
    normalized: Mapped[str] = mapped_column(String(255), nullable=False)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )


# 관계 종류 — 우선 part_of 하나. String 컬럼이라 새 종류 추가에 마이그레이션이
# 필요 없다(서비스 레이어가 허용 집합을 검증).
RELATION_PART_OF = "part_of"
ALLOWED_RELATIONS = frozenset({RELATION_PART_OF})


class EntityRelation(Base):
    """엔티티 간 방향성 관계 (p54). src --relation--> dst.

    part_of: src=자식, dst=부모 (부품 part_of 모델). M:N — 한 자식이 여러
    부모에 속할 수 있다. 양쪽 FK CASCADE 라 엔티티 삭제 시 관계도 정리된다.
    (src, dst, relation) 유니크로 중복 방지.
    """

    __tablename__ = "entity_relations"
    __table_args__ = (
        UniqueConstraint(
            "src_entity_id",
            "dst_entity_id",
            "relation",
            name="uq_entity_relations",
        ),
        Index("ix_entity_relations_dst", "dst_entity_id", "relation"),
        Index("ix_entity_relations_src", "src_entity_id", "relation"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    src_entity_id: Mapped[int] = mapped_column(
        ForeignKey("entities.id", ondelete="CASCADE"), nullable=False
    )
    dst_entity_id: Mapped[int] = mapped_column(
        ForeignKey("entities.id", ondelete="CASCADE"), nullable=False
    )
    relation: Mapped[str] = mapped_column(
        String(32), default=RELATION_PART_OF, nullable=False
    )
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
