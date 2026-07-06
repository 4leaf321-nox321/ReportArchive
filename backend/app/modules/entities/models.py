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
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
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


class EntityTemporalKind(str, enum.Enum):
    """축의 **시간 차원** 정책 (p56). 매년 값이 쌓이는 데이터에서 "올해 관련"만
    기본 노출하고 전체는 옵트인으로 보기 위해, 축마다 연도 적용 방식을 선언한다
    (엔티티그래프_온톨로지_설계.md "시간 차원"). 연도 필터(year=Y)가 걸렸을 때:

      evergreen — 연도 무관, 항상 노출(시험종류·단계·시뮬종류). 필터 무시.
      lifecycle — 값의 유효구간(valid_from_year~valid_to_year)에 Y가 들면 노출
                  (부품·BOM 등 도입/폐지가 있는 축). NULL 끝=개방(진행중).
      yearly    — 값이 명시 배정된 연도들(entity_years) 중 Y가 있으면 노출
                  (모델 — 연도별 assign, 불연속 가능).
      derived   — 명시 안 하고, 그 값이 쓰인 보고서(report_date) 연도에서 추론
                  (개방형 축의 관리비 0 경로).

    기존 7축은 evergreen 으로 시작 → 연도 필터가 no-op 이라 현행 동작 보존."""

    evergreen = "evergreen"
    lifecycle = "lifecycle"
    yearly = "yearly"
    derived = "derived"


class EntityKindClass(str, enum.Enum):
    """축의 **객체 분류** (온톨로지 강화 A0). 팔란티어식 객체 모델로 승격하기 위한
    구분 (온톨로지강화_설계.md §2.1):

      reference — 어휘/enum. 속성 거의 없음, picker 선택용(불량종류·단계·시뮬종류).
      record    — 속성을 가진 인스턴스 객체(부품·과제·공급사·시험실행·실패사례).
      system    — 기존 1급 테이블(보고서·사용자·부서)을 온톨로지에 투영. entities
                  행을 만들지 않고 ObjectRef 해석기가 원 테이블에서 라벨을 읽는다.

    기존 7축은 reference 로 시작 → 동작 불변."""

    reference = "reference"
    record = "record"
    system = "system"


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

    # 시간 차원 정책 (p56). 기존 축은 evergreen 으로 시작해 연도 필터가 no-op →
    # 현행 동작 보존. admin 이 모델→yearly, 부품→lifecycle/derived 식으로 승격.
    temporal_kind: Mapped[EntityTemporalKind] = mapped_column(
        Enum(EntityTemporalKind, name="entity_temporal_kind_enum"),
        default=EntityTemporalKind.evergreen,
        nullable=False,
    )

    # 객체 분류 (온톨로지 강화 A0). 기존 7축은 reference 로 시작 → 동작 불변.
    # record 축(부품·과제 등)만 값에 properties 를 담고, system 축은 원 테이블 투영.
    kind_class: Mapped[EntityKindClass] = mapped_column(
        Enum(EntityKindClass, name="entity_kind_class_enum"),
        default=EntityKindClass.reference,
        nullable=False,
    )


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

    # 유효구간 (p56, temporal_kind=lifecycle 축에서만 의미). NULL=개방
    # (from NULL=이전부터, to NULL=진행중). yearly 축은 entity_years 세트를,
    # evergreen/derived 축은 둘 다 무시한다.
    valid_from_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    valid_to_year: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # 객체 속성 (온톨로지 강화 A0). key=property_defs.key, 값=축 스키마에 맞는
    # 스칼라/배열. record 축에서만 의미. 기본 {} 라 기존 값 무영향. 저장 시
    # 서비스 레이어가 소속 축의 property_defs 로 검증(다음 스텝).
    properties: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default="{}", nullable=False
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


class PropertyDef(Base):
    """속성 정의 (온톨로지 강화 A0). 엔티티 타입(축) 또는 관계 타입에 붙는
    속성 스키마 한 줄. 폴리모픽 소유자 — owner_kind/owner_id 로 소속을 가리키되
    FK는 없다(entity_relations.relation 과 같은 서비스-정합 패턴).

    엔티티/관계 저장 시 이 정의로 properties(JSONB)를 검증한다(다음 스텝).
    data_type/owner_kind 는 String — PG enum 확장 고통을 피하고 서비스에서 검증
    (data_type 은 geo/file_ref 등으로 늘어날 수 있음).
    """

    __tablename__ = "property_defs"
    __table_args__ = (
        UniqueConstraint("owner_kind", "owner_id", "key", name="uq_property_defs_owner_key"),
        Index("ix_property_defs_owner", "owner_kind", "owner_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # 'entity_type' | 'relation_type'
    owner_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    owner_id: Mapped[int] = mapped_column(Integer, nullable=False)
    key: Mapped[str] = mapped_column(String(48), nullable=False)
    label: Mapped[str] = mapped_column(String(64), nullable=False)
    # text|longtext|number|date|year|bool|enum|entity_ref|url
    data_type: Mapped[str] = mapped_column(String(16), nullable=False)
    unit: Mapped[str | None] = mapped_column(String(24), nullable=True)
    required: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    multi: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # data_type=enum 일 때 선택지 [{value,label}]
    enum_options: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # data_type=entity_ref 일 때 대상 축 slug
    ref_type_slug: Mapped[str | None] = mapped_column(String(32), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    help: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
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


class EntityYear(Base):
    """yearly 축(예: 모델)의 값에 명시 배정된 연도 (p56). 한 값이 여러 연도에
    속할 수 있고 불연속도 허용(2023·2025만, 2024 빠짐) — 그래서 범위 컬럼이
    아니라 세트 테이블이다. (entity_id, year) 복합 PK 로 중복 방지, entity 삭제
    시 CASCADE.

    lifecycle 축은 이 테이블을 안 쓰고 entities.valid_from/to_year 범위를 쓴다."""

    __tablename__ = "entity_years"

    entity_id: Mapped[int] = mapped_column(
        ForeignKey("entities.id", ondelete="CASCADE"), primary_key=True
    )
    year: Mapped[int] = mapped_column(Integer, primary_key=True)

    __table_args__ = (
        Index("ix_entity_years_year", "year"),
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


# 관계 종류 기본값. 허용 집합은 더 이상 코드 상수가 아니라 relation_types 테이블
# (RelationType, p55)에서 조회한다 — 서비스 레이어가 검증. part_of 는 시드된 기본
# 타입이라 안전 기본값으로 둔다.
RELATION_PART_OF = "part_of"


class RelationType(Base):
    """엔티티 간 엣지의 *종류* 레지스트리 (p55). entity_types(축)와 대칭.

    각 타입은 방향성·이행성(재귀 펼침 대상인지)·비순환 여부·허용 출발/도착 축을
    메타로 가진다. add_relation 검증과 트래버설(이행 타입만 재귀)·향후 AI 스키마
    인지의 토대(엔티티그래프_온톨로지_설계.md §3.1).

    무FK: entity_relations.relation 이 이 slug 를 가리키되 FK 는 없다(서비스가 정합성).
    """

    __tablename__ = "relation_types"
    __table_args__ = (UniqueConstraint("slug", name="uq_relation_types_slug"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    slug: Mapped[str] = mapped_column(String(32), nullable=False)
    label: Mapped[str] = mapped_column(String(64), nullable=False)
    inverse_label: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    # 방향성 있나(false=무방향 동치).
    directed: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # 이행적 = 재귀 펼침(롤업/트래버설)에 쓰는가. part_of=true, tested_by=false.
    transitive: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # 사이클 금지 = add 시 순환 가드 적용.
    acyclic: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # 허용 출발/도착 축 slug. NULL=제약 없음.
    src_axis_slugs: Mapped[list[str] | None] = mapped_column(
        ARRAY(String(32)), nullable=True
    )
    dst_axis_slugs: Mapped[list[str] | None] = mapped_column(
        ARRAY(String(32)), nullable=True
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )


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
    # 링크 속성 (A0.2, p65). relation_type 의 property_defs 로 검증. 기본 {}.
    properties: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default="{}", nullable=False
    )
    # 근거 보고서 (provenance) — 이 링크를 주장한 보고서. 보고서 삭제 시 NULL.
    evidence_report_id: Mapped[int | None] = mapped_column(
        ForeignKey("reports.id", ondelete="SET NULL"), nullable=True
    )
    evidence_note: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )


class EntityMergeDismissal(Base):
    """"중복 아님"으로 기각한 엔티티 쌍 (p60, 엔티티머지보조_설계.md).

    중복 후보 탐지가 같은 쌍을 매번 다시 띄우지 않도록 기억하는 negative list.
    (low, high) 정규화로 (A,B)=(B,A) 중복을 막는다. 한쪽 엔티티가 머지/삭제되면
    CASCADE 로 죽은 기각행이 정리된다.
    """

    __tablename__ = "entity_merge_dismissals"
    __table_args__ = (
        UniqueConstraint(
            "entity_low_id",
            "entity_high_id",
            name="uq_entity_merge_dismissals_pair",
        ),
        Index("ix_entity_merge_dismissals_type", "type_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    type_id: Mapped[int] = mapped_column(
        ForeignKey("entity_types.id", ondelete="CASCADE"), nullable=False
    )
    entity_low_id: Mapped[int] = mapped_column(
        ForeignKey("entities.id", ondelete="CASCADE"), nullable=False
    )
    entity_high_id: Mapped[int] = mapped_column(
        ForeignKey("entities.id", ondelete="CASCADE"), nullable=False
    )
    dismissed_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    dismissed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, nullable=False
    )


class EntityMerge(Base):
    """머지 감사 로그 (p60). 누가·언제·무엇을 합쳤나.

    src 는 머지로 삭제되므로 값/코드/흡수 별칭을 **스냅샷**으로 보존한다.
    type/into 는 이후 또 머지·삭제될 수 있어 SET NULL — 이력은 스냅샷으로 유지.
    되돌리기 정책="감사 로그만"의 핵심(추적은 되지만 완전 undo 는 아님).
    """

    __tablename__ = "entity_merges"
    __table_args__ = (Index("ix_entity_merges_type", "type_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    type_id: Mapped[int | None] = mapped_column(
        ForeignKey("entity_types.id", ondelete="SET NULL"), nullable=True
    )
    src_entity_id: Mapped[int] = mapped_column(Integer, nullable=False)
    src_value: Mapped[str] = mapped_column(Text, nullable=False)
    src_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    into_entity_id: Mapped[int | None] = mapped_column(
        ForeignKey("entities.id", ondelete="SET NULL"), nullable=True
    )
    into_value: Mapped[str] = mapped_column(Text, nullable=False)
    absorbed_aliases: Mapped[list] = mapped_column(
        JSONB, default=list, nullable=False
    )
    relinked_report_count: Mapped[int] = mapped_column(
        Integer, default=0, nullable=False
    )
    merged_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    merged_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, nullable=False
    )
