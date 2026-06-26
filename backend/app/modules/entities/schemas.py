"""Pydantic schemas for the entity tagging module."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.entities.models import EntityEntryPolicy, EntityStatus


class EntityTypeRead(BaseModel):
    """One axis — picker reads a flat list from `/api/entity-types`."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    slug: str
    label: str
    icon: str
    multi: bool
    sort_order: int
    description: str
    # 입력 거버넌스 (p53). picker 가 closed 축에서 "+ 추가" 를 숨기고,
    # value_pattern 으로 입력 형식 힌트를 띄우는 데 쓴다.
    entry_policy: EntityEntryPolicy = EntityEntryPolicy.open
    value_pattern: Optional[str] = None


class EntityTypeUpdate(BaseModel):
    """Admin-only — 축의 입력 거버넌스 수정. 보낸 필드만 반영(부분 수정).
    value_pattern 을 빈 문자열/None 으로 보내면 패턴 제약 해제."""

    entry_policy: Optional[EntityEntryPolicy] = None
    value_pattern: Optional[str] = Field(default=None, max_length=255)


class EntityAliasRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    entity_id: int
    alias: str
    created_at: datetime


class EntityAliasListResponse(BaseModel):
    items: list[EntityAliasRead]


class EntityAliasCreate(BaseModel):
    alias: str = Field(..., min_length=1, max_length=255)


class EntityRelationItem(BaseModel):
    """관계 한 건의 상대 엔티티 + 관계 메타. parents/children 양쪽에서 쓴다."""

    relation_id: int
    relation: str
    entity_id: int
    value: str
    type_id: int
    type_slug: str
    code: Optional[str] = None


class EntityRelationsResponse(BaseModel):
    """parents = 이 엔티티가 part_of 한 상위들, children = 이 엔티티에 묶인 하위들."""

    parents: list[EntityRelationItem]
    children: list[EntityRelationItem]


class EntityRelationCreate(BaseModel):
    dst_entity_id: int
    relation: str = "part_of"


class RelationTypeRead(BaseModel):
    """엣지 종류 레지스트리 한 줄 (p55). 관계 추가 picker·관리 UI가 읽는다."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    slug: str
    label: str
    inverse_label: str = ""
    directed: bool = True
    transitive: bool = False
    acyclic: bool = False
    src_axis_slugs: Optional[list[str]] = None
    dst_axis_slugs: Optional[list[str]] = None
    sort_order: int = 0
    description: str = ""


class RelationTypeListResponse(BaseModel):
    items: list[RelationTypeRead]


class RelationTypeCreate(BaseModel):
    """Admin-only — 새 관계 종류 등록. slug 는 안정 식별자(entity_relations.relation
    이 가리킴) — 서비스가 정규화·중복 거부."""

    slug: str = Field(..., min_length=1, max_length=32)
    label: str = Field(..., min_length=1, max_length=64)
    inverse_label: str = Field(default="", max_length=64)
    directed: bool = True
    transitive: bool = False
    acyclic: bool = False
    src_axis_slugs: Optional[list[str]] = None
    dst_axis_slugs: Optional[list[str]] = None
    sort_order: int = Field(default=0, ge=0, le=10_000)
    description: str = Field(default="", max_length=2000)


class RelationTypeUpdate(BaseModel):
    """Admin-only — 메타 부분 수정. slug 는 불변(관계들이 가리키는 키). 축 제약은
    빈 리스트를 보내면 '제약 없음'으로 해제."""

    label: Optional[str] = Field(default=None, min_length=1, max_length=64)
    inverse_label: Optional[str] = Field(default=None, max_length=64)
    directed: Optional[bool] = None
    transitive: Optional[bool] = None
    acyclic: Optional[bool] = None
    src_axis_slugs: Optional[list[str]] = None
    dst_axis_slugs: Optional[list[str]] = None
    sort_order: Optional[int] = Field(default=None, ge=0, le=10_000)
    description: Optional[str] = Field(default=None, max_length=2000)


class EntityTypeListResponse(BaseModel):
    items: list[EntityTypeRead]


class EntityTypeCreate(BaseModel):
    """Admin-only — add a new axis. `slug` is the stable identifier; the
    service layer normalizes it (lowercase, strip) and rejects clashes
    against the existing axes. `sort_order` defaults to the end of the
    list when omitted, so newly added axes land at the right side of the
    tab strip without the admin having to compute the next index."""

    slug: str = Field(..., min_length=1, max_length=32)
    label: str = Field(..., min_length=1, max_length=64)
    icon: str = Field(default="", max_length=32)
    multi: bool = True
    sort_order: Optional[int] = Field(default=None, ge=0, le=10_000)
    description: str = Field(default="", max_length=2000)


class EntityRead(BaseModel):
    """One value. `type_slug` is denormalized so the frontend doesn't
    need a second lookup to know which axis a value belongs to —
    matches how `report_type` is flattened on Report responses."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    type_id: int
    type_slug: str
    value: str
    code: Optional[str] = None
    description: str
    status: EntityStatus
    created_by_user_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime
    # 관리 페이지에서만 채움 (admin route 가 with_usage=True 로 호출).
    # picker 경로에서는 None — 매 행마다 COUNT 서브쿼리를 돌리는 비용을
    # 의도적으로 회피. 화면에 "사용 중인 보고서 N건" 으로 노출.
    usage_count: Optional[int] = None


class EntityRefMini(BaseModel):
    """Slim form embedded inside `ReportRead.entities` — only the fields
    a list/detail page needs to render chips, without the audit columns."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    type_id: int
    type_slug: str
    value: str
    code: Optional[str] = None
    status: EntityStatus


class EntitySuggestion(EntityRefMini):
    """자동태깅 제안 1건 — 칩으로 띄울 슬림 엔티티 + 출처/점수.

    `source`='deterministic'(본문에 값/코드/별칭이 그대로 등장, score=1.0) 또는
    'similarity'(report_chunks 임베딩 유사도). **자동 태깅이 아니라 제안** — 사용자가
    수락해야 report_entities 에 들어간다(엔티티관리개선_설계.md §4.4)."""

    source: str
    score: float


class EntitySuggestResponse(BaseModel):
    items: list[EntitySuggestion]
    # 후보가 상한을 넘어 유사도 평가가 일부만 됐는지(프런트가 "일부만 검토됨" 안내).
    truncated: bool = False
    # 보고서가 이미 가진 태그(중복 추가 방지 표시용). 일괄 검토 화면의 "기존 태그" 칼럼.
    current: list[EntityRefMini] = Field(default_factory=list)


class EntityListResponse(BaseModel):
    items: list[EntityRead]


class EntityCreate(BaseModel):
    type_id: int
    value: str = Field(..., min_length=1, max_length=255)
    code: Optional[str] = Field(default=None, max_length=64)
    description: str = Field(default="", max_length=2000)


class EntityUpdate(BaseModel):
    """Admin-only edits. `value` rename is allowed but a clash check
    runs in the service layer. `status` is the deprecate/restore toggle."""

    value: Optional[str] = Field(default=None, min_length=1, max_length=255)
    code: Optional[str] = Field(default=None, max_length=64)
    description: Optional[str] = Field(default=None, max_length=2000)
    status: Optional[EntityStatus] = None


class EntityMergeRequest(BaseModel):
    """Re-link all reports from `src` to `into`, then delete `src`. Both
    must be on the same axis — enforced by the service."""

    into_id: int


class EntityUsageReportRef(BaseModel):
    """Slim ref to a report tagged with an entity. Used by the admin
    page's "어떤 보고서가 막고 있나?" lookups — populated by
    /api/entities/{id}/usage. Only the fields needed to render a list
    row + navigate are included; full report fetch is one click away."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    workspace_slug: str
    updated_at: datetime


class EntityUsageResponse(BaseModel):
    items: list[EntityUsageReportRef]
