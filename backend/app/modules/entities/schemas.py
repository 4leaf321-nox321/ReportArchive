"""Pydantic schemas for the entity tagging module."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.modules.entities.models import (
    EntityEntryPolicy,
    EntityKindClass,
    EntityStatus,
    EntityTemporalKind,
)


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
    # 시간 차원 정책 (p56). 연도 필터의 적용 방식을 축 단위로 결정.
    temporal_kind: EntityTemporalKind = EntityTemporalKind.evergreen
    # 객체 분류 (온톨로지 강화 A0.3). reference=어휘/record=속성 객체/system=투영.
    kind_class: EntityKindClass = EntityKindClass.reference


class EntityTypeUpdate(BaseModel):
    """Admin-only — 축 수정. 보낸 필드만 반영(부분 수정). slug 는 식별자라 불변.
    value_pattern 을 빈 문자열/None 으로 보내면 패턴 제약 해제."""

    # 기본 정보 (라벨=탭 이름, 아이콘, 설명, 정렬순서). slug 는 바꿀 수 없다.
    label: Optional[str] = Field(default=None, min_length=1, max_length=64)
    icon: Optional[str] = Field(default=None, max_length=32)
    description: Optional[str] = Field(default=None, max_length=2000)
    sort_order: Optional[int] = Field(default=None, ge=0, le=10_000)
    entry_policy: Optional[EntityEntryPolicy] = None
    value_pattern: Optional[str] = Field(default=None, max_length=255)
    temporal_kind: Optional[EntityTemporalKind] = None
    kind_class: Optional[EntityKindClass] = None


class PropertyDefRead(BaseModel):
    """속성 정의 한 줄 (온톨로지 강화 A0). 프론트가 이 스키마로 동적 입력 폼을
    렌더한다."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    owner_kind: str
    owner_id: int
    key: str
    label: str
    data_type: str
    unit: Optional[str] = None
    required: bool = False
    multi: bool = False
    enum_options: Optional[list] = None
    ref_type_slug: Optional[str] = None
    sort_order: int = 0
    help: Optional[str] = None


class PropertyDefListResponse(BaseModel):
    items: list[PropertyDefRead]


class PropertyDefCreate(BaseModel):
    key: str = Field(..., min_length=1, max_length=48)
    label: str = Field(..., min_length=1, max_length=64)
    data_type: str = Field(..., min_length=1, max_length=16)
    unit: Optional[str] = Field(default=None, max_length=24)
    required: bool = False
    multi: bool = False
    enum_options: Optional[list] = None
    ref_type_slug: Optional[str] = Field(default=None, max_length=32)
    sort_order: int = 0
    help: Optional[str] = Field(default=None, max_length=255)


class PropertyDefUpdate(BaseModel):
    label: Optional[str] = Field(default=None, min_length=1, max_length=64)
    data_type: Optional[str] = Field(default=None, min_length=1, max_length=16)
    unit: Optional[str] = Field(default=None, max_length=24)
    required: Optional[bool] = None
    multi: Optional[bool] = None
    enum_options: Optional[list] = None
    ref_type_slug: Optional[str] = Field(default=None, max_length=32)
    sort_order: Optional[int] = None
    help: Optional[str] = Field(default=None, max_length=255)


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
    # 링크 속성/근거 (A0.2). properties 는 relation_type 스키마로 검증된 값.
    properties: dict = Field(default_factory=dict)
    evidence_report_id: Optional[int] = None
    evidence_note: Optional[str] = None
    # 근거 보고서 제목 — 라우트가 채움(있을 때). 목록에서 라벨로 표시용.
    evidence_report_title: Optional[str] = None


class EntityRelationsResponse(BaseModel):
    """parents = 이 엔티티가 part_of 한 상위들, children = 이 엔티티에 묶인 하위들."""

    parents: list[EntityRelationItem]
    children: list[EntityRelationItem]


class EntityRelationCreate(BaseModel):
    dst_entity_id: int
    relation: str = "part_of"
    # 링크 속성/근거 (A0.2). 미지정이면 각각 {} / NULL.
    properties: Optional[dict] = None
    evidence_report_id: Optional[int] = None
    evidence_note: Optional[str] = Field(default=None, max_length=500)


class EntityRelationUpdate(BaseModel):
    """링크 속성/근거 수정 (A0.2). 보낸 필드만 반영(exclude_unset). properties 를
    보내면 관계 종류 스키마로 검증 후 통째로 교체."""

    properties: Optional[dict] = None
    evidence_report_id: Optional[int] = None
    evidence_note: Optional[str] = Field(default=None, max_length=500)


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
    # 객체 분류 (A0.3). 기본 reference — record 로 만들면 속성/객체 프로필이 열린다.
    kind_class: EntityKindClass = EntityKindClass.reference


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
    # 유효구간 (p56, lifecycle 축). NULL=개방. yearly 축은 별도 /years 엔드포인트.
    valid_from_year: Optional[int] = None
    valid_to_year: Optional[int] = None
    created_by_user_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime
    # 객체 속성 (온톨로지 강화 A0). record 축에서만 의미. 기본 {}.
    properties: dict = Field(default_factory=dict)
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


# ─── 객체 중심 검색 (Phase C) ────────────────────────────────────────────── #
class EntityPropFilter(BaseModel):
    """속성 필터 한 개. op 는 data_type 에 맞게 서비스가 해석:
    text/enum: eq·contains·in / number·date·year: eq·gte·lte·between / bool: is /
    multi(배열): has. value 는 스칼라 또는 between/in 은 리스트."""

    key: str
    op: str = "eq"
    value: Any = None


class EntityRelationFilter(BaseModel):
    """관계 필터 — dst_id 에 (relation 종류로) 연결된 객체만. relation 미지정=아무 관계."""

    dst_id: int
    relation: Optional[str] = None


class EntitySearchRequest(BaseModel):
    """객체 중심 검색 요청 (Phase C). 속성/관계 필터는 축(type_id) 기준이라야 의미."""

    type_id: Optional[int] = None
    q: Optional[str] = None
    props: list[EntityPropFilter] = Field(default_factory=list)
    relations: list[EntityRelationFilter] = Field(default_factory=list)
    year: Optional[int] = None
    include_deprecated: bool = False
    sort: str = "value"  # value | created
    limit: int = Field(default=50, ge=1, le=200)
    offset: int = Field(default=0, ge=0)


class EntitySearchResponse(BaseModel):
    items: list[EntityRead]
    total: int


class EntityCreate(BaseModel):
    type_id: int
    value: str = Field(..., min_length=1, max_length=255)
    code: Optional[str] = Field(default=None, max_length=64)
    description: str = Field(default="", max_length=2000)
    # 객체 속성 (A0). 축의 property_defs 로 검증된다. 미정의 키/형식 오류면 400.
    properties: Optional[dict] = None


class ImportRelationCol(BaseModel):
    """벌크 임포트 관계열 — 시트의 한 열을 대상 축 객체와의 관계로 매핑.
    imported 객체=src, 그 열 값으로 target_type 축에서 찾은 객체=dst."""
    column: str          # 시트 헤더
    relation: str        # 관계 slug (relation_types)
    target_type: str     # 대상 축 slug


class EntityImportMapping(BaseModel):
    """벌크 임포트 매핑 — 어느 축에, 어떤 열을 값·속성·관계로 넣을지."""
    type_id: int
    value_column: str                              # 값(이름) 열
    property_columns: dict[str, str] = {}          # 헤더 → 속성 key
    relation_columns: list[ImportRelationCol] = []
    code_column: Optional[str] = None              # 있으면 코드(안정 식별자) 매칭
    dry_run: bool = True                           # True=미리보기(쓰기 없음)


class EntityImportRowsRequest(BaseModel):
    """붙여넣기(표) 임포트 — 파일 대신 열/행을 JSON 으로. columns 는 합성 헤더
    (c0,c1…)이고 mapping 이 그 헤더로 값·속성·관계를 가리킨다."""
    mapping: EntityImportMapping
    columns: list[str]
    rows: list[list[str]]


class EntityUpdate(BaseModel):
    """Admin-only edits. `value` rename is allowed but a clash check
    runs in the service layer. `status` is the deprecate/restore toggle."""

    value: Optional[str] = Field(default=None, min_length=1, max_length=255)
    code: Optional[str] = Field(default=None, max_length=64)
    description: Optional[str] = Field(default=None, max_length=2000)
    status: Optional[EntityStatus] = None
    # 유효구간 (p56, lifecycle). 키를 보내면 반영(null 보내면 해제). yearly 축의
    # 연도 세트는 이 스키마가 아니라 PUT /entities/{id}/years 로 관리.
    valid_from_year: Optional[int] = Field(default=None, ge=1900, le=2200)
    valid_to_year: Optional[int] = Field(default=None, ge=1900, le=2200)
    # 객체 속성 (A0). 키를 보내면 축 스키마로 검증 후 통째로 교체한다.
    properties: Optional[dict] = None


class EntityYearsResponse(BaseModel):
    """yearly 축 값에 명시 배정된 연도 세트 (오름차순)."""

    years: list[int]


class EntityYearsUpdate(BaseModel):
    """Admin-only — 연도 세트 전체 교체(replace). 빈 리스트면 전부 해제."""

    years: list[int] = Field(default_factory=list)


class EntityProfileReport(BaseModel):
    """프로필의 '관련 보고서' 한 줄 — 이 객체를 태깅한 (가시성 필터된) 보고서."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    workspace_slug: str
    updated_at: datetime


class ObjectRefRead(BaseModel):
    """어떤 종류 객체든 균일하게 해석한 표시형 (A0.3 스텝2). system(부서 등)은
    원 테이블 투영, entity 는 값. 프론트가 label/url 로 칩·노드를 그린다."""

    type: str
    id: str
    kind_class: str
    label: str
    url: Optional[str] = None
    icon: str = ""
    deleted: bool = False


class ObjectLinkItem(BaseModel):
    """object_links 한 건 + 해석된 상대(ObjectRef). 프로필의 system 링크 섹션용."""

    link_id: int
    relation: str
    direction: str  # 'out' = 이 객체 → 상대, 'in' = 상대 → 이 객체
    target: ObjectRefRead
    properties: dict = Field(default_factory=dict)
    evidence_report_id: Optional[int] = None
    evidence_note: Optional[str] = None
    evidence_report_title: Optional[str] = None


class ObjectLinkCreate(BaseModel):
    """엔티티 → system 객체 링크 생성 (A0.3 스텝2)."""

    dst_type: str
    dst_id: str
    relation: str
    properties: Optional[dict] = None
    evidence_report_id: Optional[int] = None
    evidence_note: Optional[str] = Field(default=None, max_length=500)


class EntityProfileResponse(BaseModel):
    """객체 프로필(Phase A) 조합 응답 — 흩어진 정보를 한 번에 모은다. 마이그레이션
    없이 기존 서비스(상세·별칭·연도·관계·태깅보고서)를 집약. 관계도는 별도
    `/graph` 엔드포인트를 프론트가 호출하므로 여기 포함하지 않는다."""

    entity: EntityRead
    aliases: list[EntityAliasRead] = Field(default_factory=list)
    years: list[int] = Field(default_factory=list)
    relations: EntityRelationsResponse
    # cross-kind 링크 (A0.3 스텝2) — 부서 등 system 객체 연결(해석됨).
    system_links: list[ObjectLinkItem] = Field(default_factory=list)
    reports: list[EntityProfileReport] = Field(default_factory=list)
    # 가시성 적용 후 총계(reports 가 잘렸는지 안내용).
    report_count: int = 0


class EntityMergeRequest(BaseModel):
    """Re-link all reports from `src` to `into`, then delete `src`. Both
    must be on the same axis — enforced by the service."""

    into_id: int


class EntityMergeDismissRequest(BaseModel):
    """중복 후보 검토에서 "중복 아님"으로 기각할 쌍 (p60). 순서 무관 —
    서비스가 (low, high)로 정규화해 저장한다."""

    entity_id_a: int
    entity_id_b: int


class EntityMergeValidateRequest(BaseModel):
    """한 클러스터(값 묶음)를 LLM 검증자에게 보내 같은 것/다른 것 판정 (Phase 2)."""

    entity_ids: list[int]


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
