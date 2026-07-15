"""Entity tagging routes.

Two surfaces in one module:
  - `/api/entity-types`  — read-only axis catalog (system-managed)
  - `/api/entities`      — picker reads + user-can-add + admin-only edits

The link table (report ↔ entity) is NOT exposed here as its own
endpoint. Reports embed `entity_ids` in their normal PATCH /api/reports/{id}
payload (handled by reports/services.py); this keeps a single
revision-protected round-trip per save.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.entities import graph, merge_candidates, services
from app.modules.entities.schemas import (
    EntityAliasCreate,
    EntityAliasListResponse,
    EntityAliasRead,
    EntityBulkDeleteRequest,
    EntityBulkDeleteResponse,
    EntityBulkDeleteSkipped,
    EntityMoveTaggingsRequest,
    EntityReassignAxisRequest,
    EntityReassignAxisResponse,
    EntityCreate,
    EntityImportMapping,
    EntityImportRowsRequest,
    EntityListResponse,
    EntityMergeDismissRequest,
    EntityMergeRequest,
    EntityMergeValidateRequest,
    EntityProfileReport,
    EntityProfileResponse,
    EntitySearchRequest,
    EntitySearchResponse,
    ObjectLinkCreate,
    ObjectLinkItem,
    ObjectRefRead,
    EntityRead,
    EntityRelationCreate,
    EntityRelationItem,
    EntityRelationsResponse,
    EntityRelationUpdate,
    EntityTypeCreate,
    EntityTypeListResponse,
    EntityTypeRead,
    EntityTypeUpdate,
    EntityUpdate,
    EntityUsageReportRef,
    EntityUsageResponse,
    EntityYearsResponse,
    EntityYearsUpdate,
    PropertyDefCreate,
    PropertyDefListResponse,
    PropertyDefRead,
    PropertyDefUpdate,
    RelationTypeCreate,
    RelationTypeListResponse,
    RelationTypeRead,
    RelationTypeUpdate,
)
from app.modules.users.models import Role, User, WorkspaceMember
from app.shared.auth import _resolve_user_from_token, bearer_scheme
from app.shared.responses import (
    created_response,
    error_response,
    not_found_response,
    success_response,
)


# --------------------------------------------------------------------------- #
# Auth dep — no workspace required. `is_admin` here means SYSTEM admin
# (User.is_system_admin), since entity master data is org-wide
# infrastructure. 부서 관리자 (workspace admin) can still *use* entity
# tags on reports; only system admins can edit the underlying vocabulary.
# --------------------------------------------------------------------------- #
@dataclass
class EntityActor:
    user: User
    is_admin: bool


def entity_actor(
    db: Session = Depends(get_db),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    _x_workspace_slug: Optional[str] = Header(default=None, alias="X-Workspace-Slug"),
) -> EntityActor:
    user = _resolve_user_from_token(db, credentials)
    return EntityActor(user=user, is_admin=user.is_system_admin)


def _require_admin(actor: EntityActor) -> None:
    if not actor.is_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "관리자만 가능한 작업입니다."
        )


def _to_read(row, usage_count: Optional[int] = None) -> EntityRead:
    """Hand-flatten `type_slug` from the joined EntityType — Pydantic's
    `from_attributes` can't walk a relationship into a sibling field by
    itself. `usage_count` is None for picker reads, an int for admin
    reads (when the route requested `with_usage=true`)."""
    return EntityRead(
        id=row.id,
        type_id=row.type_id,
        type_slug=row.entity_type.slug if row.entity_type else "",
        value=row.value,
        code=row.code,
        description=row.description,
        status=row.status,
        valid_from_year=row.valid_from_year,
        valid_to_year=row.valid_to_year,
        created_by_user_id=row.created_by_user_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
        properties=row.properties or {},
        usage_count=usage_count,
    )


# --------------------------------------------------------------------------- #
# entity-types router — `/api/entity-types`
# --------------------------------------------------------------------------- #
entity_types_router = APIRouter()


@entity_types_router.get("")
def list_entity_types(
    _actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """All axes. Auth required (so anonymous probes can't enumerate the
    taxonomy), but no role gate — the picker UI needs this for every user."""
    rows = services.list_types(db)
    return success_response(
        data=EntityTypeListResponse(
            items=[EntityTypeRead.model_validate(r) for r in rows]
        )
    )


@entity_types_router.post("", status_code=201)
def create_entity_type(
    payload: EntityTypeCreate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — add a new axis. Until this route existed axes could
    only be added via migration seed; now the entity admin page can
    self-service when a new tagging dimension is needed (regulatory
    field, product line split, etc.) without a deploy."""
    _require_admin(actor)
    try:
        row = services.create_type(db, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=EntityTypeRead.model_validate(row))


@entity_types_router.patch("/{type_id}")
def update_entity_type(
    type_id: int,
    payload: EntityTypeUpdate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 축의 입력 거버넌스(entry_policy·value_pattern) 수정. closed
    면 사용자 즉석 추가가 막히고, value_pattern 으로 새 값 형식을 강제한다."""
    _require_admin(actor)
    row = services.get_type(db, type_id)
    if not row:
        return not_found_response(f"엔티티 축을 찾을 수 없습니다: {type_id}")
    try:
        row = services.update_type(db, row, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(data=EntityTypeRead.model_validate(row))


@entity_types_router.delete("/{type_id}")
def delete_entity_type(
    type_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only. Blocked when the axis still has any values
    (active or deprecated) — the response message includes the count so
    the admin can decide whether to merge/delete the values first.
    Matches the pattern delete_entity uses for in-use values."""
    _require_admin(actor)
    row = services.get_type(db, type_id)
    if not row:
        return not_found_response(f"엔티티 축을 찾을 수 없습니다: {type_id}")
    name = row.label
    try:
        services.delete_type(db, row)
    except ValueError as exc:
        return error_response(str(exc), status_code=400)
    return success_response(data=None, message=f"'{name}' 축이 삭제됐습니다.")


# ─── 속성 정의 (property_defs) — 축의 객체 속성 스키마 (온톨로지 강화 A0) ──── #
@entity_types_router.get("/{type_id}/properties")
def list_type_properties(
    type_id: int,
    _actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """축의 속성 정의 목록. 인증만 — 프론트가 동적 속성 폼을 렌더하는 데 쓴다."""
    if not services.get_type(db, type_id):
        return not_found_response(f"엔티티 축을 찾을 수 없습니다: {type_id}")
    defs = services.list_property_defs(db, owner_kind="entity_type", owner_id=type_id)
    return success_response(
        data=PropertyDefListResponse(
            items=[PropertyDefRead.model_validate(d) for d in defs]
        )
    )


@entity_types_router.post("/{type_id}/properties", status_code=201)
def create_type_property(
    type_id: int,
    payload: PropertyDefCreate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 축에 속성 정의 추가."""
    _require_admin(actor)
    if not services.get_type(db, type_id):
        return not_found_response(f"엔티티 축을 찾을 수 없습니다: {type_id}")
    try:
        row = services.create_property_def(
            db, owner_kind="entity_type", owner_id=type_id, payload=payload
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=PropertyDefRead.model_validate(row))


@entity_types_router.patch("/{type_id}/properties/{def_id}")
def update_type_property(
    type_id: int,
    def_id: int,
    payload: PropertyDefUpdate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 속성 정의 수정."""
    _require_admin(actor)
    row = services.get_property_def(db, def_id)
    if row is None or row.owner_kind != "entity_type" or row.owner_id != type_id:
        return not_found_response(f"속성 정의를 찾을 수 없습니다: {def_id}")
    try:
        row = services.update_property_def(db, row, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(data=PropertyDefRead.model_validate(row))


@entity_types_router.delete("/{type_id}/properties/{def_id}")
def delete_type_property(
    type_id: int,
    def_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 속성 정의 삭제. 기존 엔티티의 properties 값은 남지만 응답에서
    검증 대상이 아니게 된다(soft — 값 보존)."""
    _require_admin(actor)
    row = services.get_property_def(db, def_id)
    if row is None or row.owner_kind != "entity_type" or row.owner_id != type_id:
        return not_found_response(f"속성 정의를 찾을 수 없습니다: {def_id}")
    services.delete_property_def(db, row)
    return success_response(data=None, message="속성 정의가 삭제됐습니다.")


@entity_types_router.post("/{type_id}/merge-candidates")
def scan_merge_candidates(
    type_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """축의 중복/동의어 후보 클러스터(엔티티머지보조_설계.md §6). 온디맨드 스캔 —
    저장 안 함. L0 정규화 + L1 임베딩(넓은 그물). 오탐은 검토 UI/LLM 이 거른다.
    Admin only."""
    _require_admin(actor)
    if not services.get_type(db, type_id):
        return not_found_response(f"엔티티 축을 찾을 수 없습니다: {type_id}")
    try:
        result = merge_candidates.find_merge_candidates(db, type_id)
    except ValueError as exc:
        return error_response(str(exc), status_code=400)
    return success_response(data=result)


@entity_types_router.post("/{type_id}/merge-validate")
def validate_merge_cluster(
    type_id: int,
    payload: EntityMergeValidateRequest,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """LLM 검증자 (Phase 2, §5) — 한 클러스터의 값들을 LLM 이 판정해 같은 것
    (duplicates)·다른 것(outliers)·대표(canonical)로 분리. UI 의 멤버 체크박스를
    자동 세팅한다. Admin only(엔티틀먼트 bypass). mock 백엔드면 verdict 없음."""
    _require_admin(actor)
    if not services.get_type(db, type_id):
        return not_found_response(f"엔티티 축을 찾을 수 없습니다: {type_id}")
    try:
        verdict = merge_candidates.validate_cluster(
            db, type_id, payload.entity_ids
        )
    except ValueError as exc:
        return error_response(str(exc), status_code=400)
    return success_response(data=verdict)


@entity_types_router.post("/{type_id}/merge-dismiss")
def dismiss_merge_candidate(
    type_id: int,
    payload: EntityMergeDismissRequest,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """중복 후보 쌍을 "중복 아님"으로 기각 → 다음 스캔부터 제외(p60). Admin only."""
    _require_admin(actor)
    a = services.get_entity(db, payload.entity_id_a)
    b = services.get_entity(db, payload.entity_id_b)
    if not a or not b:
        return not_found_response("기각할 엔티티를 찾을 수 없습니다.")
    try:
        added = services.dismiss_merge_pair(
            db, entity_a=a, entity_b=b, user_id=actor.user.id
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(
        data={"dismissed": added},
        message="중복 아님으로 표시했습니다." if added else "이미 기각된 쌍입니다.",
    )


# --------------------------------------------------------------------------- #
# relation-types router — `/api/relation-types` (엣지 종류 레지스트리, p55)
# --------------------------------------------------------------------------- #
relation_types_router = APIRouter()


@relation_types_router.get("")
def list_relation_types(
    _actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """모든 관계 종류. 관계 추가 picker(타입 선택)와 관리 UI가 읽는다. 인증만
    필요(역할 게이트 없음 — picker 가 모든 사용자에 필요)."""
    rows = services.list_relation_types(db)
    return success_response(
        data=RelationTypeListResponse(
            items=[RelationTypeRead.model_validate(r) for r in rows]
        )
    )


@relation_types_router.post("", status_code=201)
def create_relation_type(
    payload: RelationTypeCreate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 새 관계 종류 등록. slug 중복은 거부."""
    _require_admin(actor)
    try:
        row = services.create_relation_type(db, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=RelationTypeRead.model_validate(row))


@relation_types_router.patch("/{slug}")
def update_relation_type(
    slug: str,
    payload: RelationTypeUpdate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 메타 수정(slug 불변)."""
    _require_admin(actor)
    row = services.get_relation_type(db, slug)
    if not row:
        return not_found_response(f"관계 종류를 찾을 수 없습니다: {slug}")
    try:
        row = services.update_relation_type(db, row, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(data=RelationTypeRead.model_validate(row))


@relation_types_router.delete("/{slug}")
def delete_relation_type(
    slug: str,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only. 그 타입을 쓰는 엔티티 관계가 있으면 거부(고아 방지)."""
    _require_admin(actor)
    row = services.get_relation_type(db, slug)
    if not row:
        return not_found_response(f"관계 종류를 찾을 수 없습니다: {slug}")
    label = row.label
    try:
        services.delete_relation_type(db, row)
    except ValueError as exc:
        return error_response(str(exc), status_code=400)
    return success_response(data=None, message=f"'{label}' 관계 종류가 삭제됐습니다.")


# ─── 관계 속성 정의 — 링크가 나르는 속성 스키마 (A0.2) ────────────────────── #
# entity-types 의 /properties 와 대칭. owner_kind='relation_type'. slug 로 조회.
@relation_types_router.get("/{slug}/properties")
def list_relation_type_properties(
    slug: str,
    _actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """관계 종류의 링크 속성 정의 목록(인증만) — 프론트 링크 속성 폼 렌더용."""
    rtype = services.get_relation_type(db, slug)
    if not rtype:
        return not_found_response(f"관계 종류를 찾을 수 없습니다: {slug}")
    defs = services.list_property_defs(
        db, owner_kind="relation_type", owner_id=rtype.id
    )
    return success_response(
        data=PropertyDefListResponse(
            items=[PropertyDefRead.model_validate(d) for d in defs]
        )
    )


@relation_types_router.post("/{slug}/properties", status_code=201)
def create_relation_type_property(
    slug: str,
    payload: PropertyDefCreate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 관계 종류에 링크 속성 정의 추가."""
    _require_admin(actor)
    rtype = services.get_relation_type(db, slug)
    if not rtype:
        return not_found_response(f"관계 종류를 찾을 수 없습니다: {slug}")
    try:
        row = services.create_property_def(
            db, owner_kind="relation_type", owner_id=rtype.id, payload=payload
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=PropertyDefRead.model_validate(row))


@relation_types_router.patch("/{slug}/properties/{def_id}")
def update_relation_type_property(
    slug: str,
    def_id: int,
    payload: PropertyDefUpdate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 링크 속성 정의 수정."""
    _require_admin(actor)
    rtype = services.get_relation_type(db, slug)
    if not rtype:
        return not_found_response(f"관계 종류를 찾을 수 없습니다: {slug}")
    row = services.get_property_def(db, def_id)
    if row is None or row.owner_kind != "relation_type" or row.owner_id != rtype.id:
        return not_found_response(f"속성 정의를 찾을 수 없습니다: {def_id}")
    try:
        row = services.update_property_def(db, row, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(data=PropertyDefRead.model_validate(row))


@relation_types_router.delete("/{slug}/properties/{def_id}")
def delete_relation_type_property(
    slug: str,
    def_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 링크 속성 정의 삭제(기존 링크 값은 보존)."""
    _require_admin(actor)
    rtype = services.get_relation_type(db, slug)
    if not rtype:
        return not_found_response(f"관계 종류를 찾을 수 없습니다: {slug}")
    row = services.get_property_def(db, def_id)
    if row is None or row.owner_kind != "relation_type" or row.owner_id != rtype.id:
        return not_found_response(f"속성 정의를 찾을 수 없습니다: {def_id}")
    services.delete_property_def(db, row)
    return success_response(data=None, message="속성 정의가 삭제됐습니다.")


# --------------------------------------------------------------------------- #
# entities router — `/api/entities`
# --------------------------------------------------------------------------- #
entities_router = APIRouter()


@entities_router.get("")
def list_entities(
    type_id: Optional[int] = Query(default=None),
    q: Optional[str] = Query(default=None, max_length=128),
    include_deprecated: bool = Query(default=False),
    limit: int = Query(default=200, ge=1, le=500),
    with_usage: bool = Query(default=False),
    related_to: Optional[list[int]] = Query(default=None),
    year: Optional[int] = Query(default=None, ge=1900, le=2200),
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Picker list. Defaults to active-only; admin page passes
    `include_deprecated=true`. Without `type_id` returns across all
    axes (mostly useful for global search).

    `year` (p56) filters by the axis's temporal policy: evergreen 축은
    무시(항상 포함), lifecycle=유효구간, yearly=배정연도, derived=그 해
    보고서에 등장. 미지정이면 전체(연도 무관).

    `with_usage=true` is admin-only — it adds a per-row COUNT subquery
    to populate `usage_count`. We gate it on role to keep the picker
    path lean and to avoid leaking "this value is used by N reports"
    to non-admins (a minor info-disclosure, but trivial to gate)."""
    if with_usage and not actor.is_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "with_usage 는 관리자만 사용할 수 있습니다."
        )
    rows = services.list_entities(
        db,
        type_id=type_id,
        q=q,
        include_deprecated=include_deprecated,
        limit=limit,
        with_usage=with_usage,
        related_to=related_to or None,
        year=year,
    )
    if with_usage:
        items = [_to_read(r, usage_count=cnt) for (r, cnt) in rows]
    else:
        items = [_to_read(r) for r in rows]
    return success_response(data=EntityListResponse(items=items))


@entities_router.post("/search")
def search_entities(
    payload: EntitySearchRequest,
    _actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """객체 중심 검색 (Phase C) — 인증-only. 타입 + 이름(q) + 속성(JSONB) + 관계 +
    연도 로 객체를 찾는다. 속성/관계 필터는 type_id 기준이라야 의미. 반환:
    `{ items: EntityRead[], total }`(정렬·페이지 적용)."""
    rows, total = services.search_entities(
        db,
        type_id=payload.type_id,
        q=payload.q,
        props=[p.model_dump() for p in payload.props],
        relations=[r.model_dump() for r in payload.relations],
        year=payload.year,
        include_deprecated=payload.include_deprecated,
        sort=payload.sort,
        limit=payload.limit,
        offset=payload.offset,
    )
    return success_response(
        data=EntitySearchResponse(items=[_to_read(r) for r in rows], total=total)
    )


# --------------------------------------------------------------------------- #
# 벌크 임포트 (데이터 채우기) — 관리자만. 시트로 객체+속성+관계 시딩.
# --------------------------------------------------------------------------- #
@entities_router.post("/import/inspect")
async def import_inspect(
    file: UploadFile = File(...),
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """업로드 시트의 헤더+샘플을 돌려준다(열 매핑 UI용). 관리자 전용."""
    from app.modules.entities import import_service

    _require_admin(actor)
    content = await file.read()
    try:
        headers, rows = import_service.parse_sheet(file.filename or "", content)
    except ValueError as exc:
        return error_response(str(exc), status_code=400)
    return success_response(
        data={"columns": headers, "sample": rows[:5], "row_count": len(rows)}
    )


@entities_router.post("/import")
async def import_entities(
    file: UploadFile = File(...),
    mapping: str = Form(...),
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """시트 + 매핑(JSON) → 객체 생성/갱신 + 관계 링크. mapping.dry_run=True 면
    미리보기(검증만·쓰기 없음). 관리자 전용. 반환: {summary, rows}."""
    from app.modules.entities import import_service

    _require_admin(actor)
    try:
        payload = EntityImportMapping.model_validate_json(mapping)
    except ValueError as exc:
        return error_response(f"매핑 형식 오류: {exc}", status_code=400)
    content = await file.read()
    try:
        _headers, rows = import_service.parse_sheet(file.filename or "", content)
        result = import_service.run_import(
            db, mapping=payload, rows=rows,
            creator_user_id=actor.user.id, dry_run=payload.dry_run,
        )
    except ValueError as exc:
        return error_response(str(exc), status_code=400)
    return success_response(data=result)


@entities_router.post("/import/rows")
def import_rows(
    payload: EntityImportRowsRequest,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """붙여넣기(표) 임포트 — 파일 없이 열/행 JSON 으로. 각 행을 헤더로 dict 화해
    파일 임포트와 같은 run_import 로 처리. mapping.dry_run=True 면 미리보기. 관리자 전용."""
    from app.modules.entities import import_service

    _require_admin(actor)
    rows = [dict(zip(payload.columns, r)) for r in payload.rows]
    try:
        result = import_service.run_import(
            db, mapping=payload.mapping, rows=rows,
            creator_user_id=actor.user.id, dry_run=payload.mapping.dry_run,
        )
    except ValueError as exc:
        return error_response(str(exc), status_code=400)
    return success_response(data=result)


@entities_router.post("", status_code=201)
def create_entity(
    payload: EntityCreate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Any authenticated user can add. Pre-existing same-value rows are
    returned as-is (the service collapses the dup to a single canonical
    row) — picker treats either response as success."""
    try:
        row = services.create_entity(
            db, payload, creator_user_id=actor.user.id
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=_to_read(row))


@entities_router.patch("/{entity_id}")
def update_entity(
    entity_id: int,
    payload: EntityUpdate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    _require_admin(actor)
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    try:
        row = services.update_entity(db, row, payload)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(data=_to_read(row))


@entities_router.get("/{entity_id}/years")
def list_entity_years(
    entity_id: int,
    _actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """yearly 축(모델 등) 값에 배정된 연도 세트 (p56). 인증만 필요(읽기) — 편집
    다이얼로그·탐색에서 읽는다. 다른 축이면 보통 빈 리스트."""
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    years = services.get_entity_years(db, entity_id)
    return success_response(data=EntityYearsResponse(years=years))


@entities_router.put("/{entity_id}/years")
def set_entity_years(
    entity_id: int,
    payload: EntityYearsUpdate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 연도 세트 전체 교체 (p56). 빈 리스트면 전부 해제."""
    _require_admin(actor)
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    years = services.set_entity_years(db, row, payload.years)
    return success_response(data=EntityYearsResponse(years=years))


@entities_router.post("/{entity_id}/merge")
def merge_entity(
    entity_id: int,
    payload: EntityMergeRequest,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Re-link all reports from `entity_id` to `payload.into_id`, drop
    the source. Admin only — fixing user-introduced duplicates is the
    primary use case."""
    _require_admin(actor)
    src = services.get_entity(db, entity_id)
    if not src:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    into = services.get_entity(db, payload.into_id)
    if not into:
        return not_found_response(
            f"머지 대상 엔티티를 찾을 수 없습니다: {payload.into_id}"
        )
    try:
        relinked = services.merge_entities(
            db, src=src, into=into, merged_by_user_id=actor.user.id
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return success_response(
        data={"relinked_report_count": relinked, "into_id": into.id},
        message=f"'{src.value}' → '{into.value}' 머지 완료. {relinked}건 재연결.",
    )


@entities_router.get("/{entity_id}/usage")
def list_entity_usage(
    entity_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only. Returns the slim list of reports currently tagged with
    this entity — used by the admin page's delete/merge dialogs and the
    "사용 N건" cell popover to surface which reports are blocking a
    destructive action. Workspace-agnostic on purpose: the admin needs
    to see all blockers, not just ones in their current workspace tree."""
    _require_admin(actor)
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    items = services.list_reports_using_entity(db, entity_id=entity_id)
    return success_response(
        data=EntityUsageResponse(
            items=[
                EntityUsageReportRef(
                    id=r_id,
                    title=title,
                    workspace_slug=ws,
                    updated_at=updated_at,
                )
                for (r_id, title, ws, updated_at) in items
            ]
        )
    )


@entities_router.delete("/{entity_id}/usage/{report_id}")
def unlink_one_report(
    entity_id: int,
    report_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — drop the (entity, report) link from the M:N table.
    The entity row itself stays. Idempotent: removing a link that doesn't
    exist still returns 200 (the desired state already holds)."""
    _require_admin(actor)
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    removed = services.unlink_from_report(
        db, entity_id=entity_id, report_id=report_id
    )
    return success_response(
        data={"removed": removed, "report_id": report_id},
        message=(
            f"보고서 {report_id} 에서 '{row.value}' 태그 해제됨."
            if removed
            else f"보고서 {report_id} 에는 '{row.value}' 태그가 없었습니다."
        ),
    )


@entities_router.delete("/{entity_id}/usage")
def unlink_all_reports(
    entity_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — drop every link this entity has across all reports.
    Bulk version of the per-report unlink above. After this runs the
    entity has 0 usage and can be hard-deleted via the regular endpoint.
    Returns the number of links removed."""
    _require_admin(actor)
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    count = services.unlink_from_all_reports(db, entity_id=entity_id)
    return success_response(
        data={"removed_count": count},
        message=f"{count}건의 보고서에서 '{row.value}' 태그 해제됨.",
    )


@entities_router.post("/{entity_id}/move-taggings")
def move_taggings(
    entity_id: int,
    payload: EntityMoveTaggingsRequest,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 이 값이 걸린 보고서 태깅을 같은 축의 다른 값(into_id)으로
    옮긴다. "모두 해제"의 '이동' 버전 — 원본 값은 남는다(이후 사용 0건이 돼 삭제
    가능). report_ids 를 주면 그 보고서들만 옮긴다(일부 이동). 다른 축 대상은 400."""
    _require_admin(actor)
    src = services.get_entity(db, entity_id)
    if not src:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    into = services.get_entity(db, payload.into_id)
    if not into:
        return not_found_response(f"대상 값을 찾을 수 없습니다: {payload.into_id}")
    try:
        count = services.move_taggings(
            db, src=src, into=into, report_ids=payload.report_ids
        )
    except ValueError as exc:
        return error_response(str(exc), status_code=400)
    return success_response(
        data={"moved_count": count},
        message=f"{count}건의 보고서를 '{src.value}' → '{into.value}' 로 이동함.",
    )


@entities_router.get("/{entity_id}/aliases")
def list_entity_aliases(
    entity_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 이 엔티티의 별칭(다른 표기) 목록. 관리 화면에서 표시·삭제용.
    입력 resolve 는 서버가 자동으로 하므로 picker 는 이 목록이 필요 없다."""
    _require_admin(actor)
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    items = services.list_aliases(db, entity_id=entity_id)
    return success_response(
        data=EntityAliasListResponse(
            items=[EntityAliasRead.model_validate(a) for a in items]
        )
    )


@entities_router.post("/{entity_id}/aliases", status_code=201)
def add_entity_alias(
    entity_id: int,
    payload: EntityAliasCreate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 별칭 추가. 같은 축의 다른 값/별칭과 충돌하면 400."""
    _require_admin(actor)
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    try:
        alias = services.add_alias(
            db, entity=row, alias=payload.alias, creator_user_id=actor.user.id
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=EntityAliasRead.model_validate(alias))


@entities_router.delete("/{entity_id}/aliases/{alias_id}")
def delete_entity_alias(
    entity_id: int,
    alias_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 별칭 삭제. 이후 그 표기 입력은 더 이상 자동 흡수되지 않는다."""
    _require_admin(actor)
    alias = services.get_alias(db, alias_id)
    if not alias or alias.entity_id != entity_id:
        return not_found_response(f"별칭을 찾을 수 없습니다: {alias_id}")
    label = alias.alias
    services.delete_alias(db, alias)
    return success_response(data=None, message=f"별칭 '{label}' 삭제됨.")


def _relation_item(counterpart, rel, evidence_title=None) -> EntityRelationItem:
    """관계 행 + 상대 엔티티 → 응답 아이템. A0.2: 링크 속성/근거 포함."""
    return EntityRelationItem(
        relation_id=rel.id,
        relation=rel.relation,
        entity_id=counterpart.id,
        value=counterpart.value,
        type_id=counterpart.type_id,
        type_slug=counterpart.entity_type.slug if counterpart.entity_type else "",
        code=counterpart.code,
        properties=rel.properties or {},
        evidence_report_id=rel.evidence_report_id,
        evidence_note=rel.evidence_note,
        evidence_report_title=evidence_title,
    )


def _evidence_title(db: Session, report_id, cache: dict):
    """근거 보고서 제목 해석 (작은 캐시로 목록 N+1 완화). 없으면 None."""
    if report_id is None:
        return None
    if report_id not in cache:
        from app.modules.reports.models import Report

        r = db.get(Report, report_id)
        cache[report_id] = r.title if r else None
    return cache[report_id]


def _relations_response(db: Session, entity_id: int) -> EntityRelationsResponse:
    """이 엔티티의 모든 관계(종류 불문, p55) → parents/children 아이템.
    관계 라우트와 프로필 라우트가 공유한다(A0.2 링크 속성/근거 포함)."""
    parents, children = services.list_relations(db, entity_id=entity_id)
    title_cache: dict = {}
    parent_items = []
    for r in parents:
        cp = services.get_entity(db, r.dst_entity_id)
        if cp:
            parent_items.append(
                _relation_item(cp, r, _evidence_title(db, r.evidence_report_id, title_cache))
            )
    child_items = []
    for r in children:
        cp = services.get_entity(db, r.src_entity_id)
        if cp:
            child_items.append(
                _relation_item(cp, r, _evidence_title(db, r.evidence_report_id, title_cache))
            )
    return EntityRelationsResponse(parents=parent_items, children=child_items)


@entities_router.get("/{entity_id}/relations")
def list_entity_relations(
    entity_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 이 엔티티의 **모든** 관계(종류 불문, p55). parents = 이 값이
    src 인 관계(part_of 면 상위), children = 이 값이 dst 인 관계(part_of 면 하위).
    각 item 에 relation slug 가 있어 화면이 종류별로 묶어 표시한다."""
    _require_admin(actor)
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    return success_response(data=_relations_response(db, entity_id))


def _object_link_item(db, link, direction, other, title_cache) -> ObjectLinkItem:
    """object_links 행 + 해석된 상대(ObjectRef) → 응답 아이템 (A0.3 스텝2)."""
    return ObjectLinkItem(
        link_id=link.id,
        relation=link.relation,
        direction=direction,
        target=ObjectRefRead(**other),
        properties=link.properties or {},
        evidence_report_id=link.evidence_report_id,
        evidence_note=link.evidence_note,
        evidence_report_title=_evidence_title(db, link.evidence_report_id, title_cache),
    )


def _system_links_for(db, row) -> list[ObjectLinkItem]:
    """이 엔티티의 object_links(양방향) → 상대를 ObjectRef 로 해석해 아이템화.
    해석 실패(삭제된 대상 등)는 건너뛴다."""
    axis = row.entity_type.slug if row.entity_type else ""
    outgoing, incoming = services.list_object_links_for_entity(
        db, entity_id=row.id, axis_slug=axis
    )
    cache: dict = {}
    items: list[ObjectLinkItem] = []
    for link in outgoing:
        other = services.resolve_object(db, link.dst_type, link.dst_id)
        if other:
            items.append(_object_link_item(db, link, "out", other, cache))
    for link in incoming:
        other = services.resolve_object(db, link.src_type, link.src_id)
        if other:
            items.append(_object_link_item(db, link, "in", other, cache))
    return items


@entities_router.get("/{entity_id}/profile")
def get_entity_profile(
    entity_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """객체 프로필(Phase A) — 인증-only 읽기. 흩어진 정보를 한 번에 모은다:
    상세·별칭·연도·관계(속성/근거 포함)·이 값을 태깅한 보고서(가시성 교집합).
    관계도는 프론트가 별도 `/graph` 를 호출한다(중복 방지). 마이그레이션 0.

    보고서는 요청자가 볼 수 있는 것만 — 사용자 중심 가시성(활성 워크스페이스 무관,
    멤버십 기반)으로 교집합해 전역 유출을 막는다."""
    from app.modules.reports.services import all_visible_report_ids

    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")

    aliases = services.list_aliases(db, entity_id=entity_id)
    years = services.get_entity_years(db, entity_id)
    relations = _relations_response(db, entity_id)

    # 태깅 보고서 ∩ 가시성(휴지통 제외는 서비스가 처리).
    rows = services.list_report_links_for_entity(db, entity_id=entity_id)
    visible = all_visible_report_ids(db, actor.user.id)
    reports = [
        EntityProfileReport(
            id=r.id,
            title=r.title,
            workspace_slug=r.workspace_slug,
            updated_at=r.updated_at,
        )
        for r in rows
        if r.id in visible
    ]

    return success_response(
        data=EntityProfileResponse(
            entity=_to_read(row),
            aliases=[EntityAliasRead.model_validate(a) for a in aliases],
            years=years,
            relations=relations,
            system_links=_system_links_for(db, row),
            reports=reports,
            report_count=len(reports),
        )
    )


@entities_router.post("/{entity_id}/relations", status_code=201)
def add_entity_relation(
    entity_id: int,
    payload: EntityRelationCreate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 상위(part_of) 추가. entity_id 가 자식(src), dst 가 부모.
    자기참조·중복·순환은 400."""
    _require_admin(actor)
    src = services.get_entity(db, entity_id)
    if not src:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    dst = services.get_entity(db, payload.dst_entity_id)
    if not dst:
        return not_found_response(
            f"상위 대상 엔티티를 찾을 수 없습니다: {payload.dst_entity_id}"
        )
    try:
        rel = services.add_relation(
            db,
            src=src,
            dst=dst,
            relation=payload.relation,
            creator_user_id=actor.user.id,
            properties=payload.properties,
            evidence_report_id=payload.evidence_report_id,
            evidence_note=payload.evidence_note,
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(
        data=_relation_item(dst, rel, _evidence_title(db, rel.evidence_report_id, {}))
    )


@entities_router.patch("/{entity_id}/relations/{relation_id}")
def update_entity_relation(
    entity_id: int,
    relation_id: int,
    payload: EntityRelationUpdate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 링크 속성/근거 수정 (A0.2). entity_id 는 관계의 한쪽이어야
    한다. 보낸 필드만 반영(properties 는 관계 종류 스키마로 검증 후 교체)."""
    _require_admin(actor)
    rel = services.get_relation(db, relation_id)
    if not rel or (
        rel.src_entity_id != entity_id and rel.dst_entity_id != entity_id
    ):
        return not_found_response(f"관계를 찾을 수 없습니다: {relation_id}")
    provided = payload.model_dump(exclude_unset=True)
    kwargs = {k: provided[k] for k in ("properties", "evidence_report_id", "evidence_note") if k in provided}
    try:
        rel = services.update_relation(db, rel, **kwargs)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    other_id = rel.dst_entity_id if rel.src_entity_id == entity_id else rel.src_entity_id
    counterpart = services.get_entity(db, other_id)
    return success_response(
        data=_relation_item(counterpart, rel, _evidence_title(db, rel.evidence_report_id, {}))
    )


@entities_router.delete("/{entity_id}/relations/{relation_id}")
def delete_entity_relation(
    entity_id: int,
    relation_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 관계 삭제. entity_id 가 관계의 한쪽(자식이든 부모든)이어야
    한다(양쪽 관리 화면 모두에서 끊을 수 있게)."""
    _require_admin(actor)
    rel = services.get_relation(db, relation_id)
    if not rel or (
        rel.src_entity_id != entity_id and rel.dst_entity_id != entity_id
    ):
        return not_found_response(f"관계를 찾을 수 없습니다: {relation_id}")
    services.delete_relation(db, rel)
    return success_response(data=None, message="관계가 삭제됐습니다.")


# ─── object_links — entity ↔ system 객체(부서 등) 링크 (A0.3 스텝2) ─────────── #
@entities_router.get("/{entity_id}/object-links")
def list_entity_object_links(
    entity_id: int,
    _actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """이 엔티티의 cross-kind 링크(해석됨) — 인증-only. 프로필과 같은 아이템 형태."""
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    return success_response(data={"items": _system_links_for(db, row)})


@entities_router.post("/{entity_id}/object-links", status_code=201)
def add_entity_object_link(
    entity_id: int,
    payload: ObjectLinkCreate,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — 이 엔티티(src) → system 객체(dst_type/dst_id) 링크 추가."""
    _require_admin(actor)
    src = services.get_entity(db, entity_id)
    if not src:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    try:
        link = services.add_object_link(
            db,
            src=src,
            dst_type=payload.dst_type,
            dst_id=payload.dst_id,
            relation=payload.relation,
            creator_user_id=actor.user.id,
            properties=payload.properties,
            evidence_report_id=payload.evidence_report_id,
            evidence_note=payload.evidence_note,
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    other = services.resolve_object(db, link.dst_type, link.dst_id)
    return created_response(data=_object_link_item(db, link, "out", other, {}))


@entities_router.delete("/{entity_id}/object-links/{link_id}")
def delete_entity_object_link(
    entity_id: int,
    link_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Admin-only — cross-kind 링크 삭제. entity_id 가 링크의 한쪽이어야 한다."""
    _require_admin(actor)
    link = services.get_object_link(db, link_id)
    sid = str(entity_id)
    if not link or (link.src_id != sid and link.dst_id != sid):
        return not_found_response(f"링크를 찾을 수 없습니다: {link_id}")
    services.delete_object_link(db, link)
    return success_response(data=None, message="링크가 삭제됐습니다.")


@entities_router.get("/{entity_id}/graph")
def entity_subgraph(
    entity_id: int,
    relations: Optional[list[str]] = Query(default=None, alias="relations"),
    depth: int = Query(default=2, ge=1, le=10),
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """이 엔티티 주변 서브그래프(노드+엣지, D-2). 재귀 CTE(graph.subgraph)로 양방향
    `depth` hop 까지. `relations`(반복) 로 따라갈 관계 종류 제한(미지정=전체).
    관계도 시각화·AI(GraphRAG) 컨텍스트의 토대. 인증만 필요(읽기).

    일반 사용자(비관리자)에겐 active 엔티티만 노출한다 — deprecated 기준정보는
    관리자만 본다(엔티티 관리 화면). 시드 자신은 deprecated 라도 중심으로 남는다."""
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    data = graph.subgraph(
        db,
        [entity_id],
        relations=relations or None,
        max_depth=depth,
        active_only=not actor.is_admin,
    )
    _augment_graph_object_links(db, data)
    return success_response(data=data)


def _augment_graph_object_links(db, data) -> None:
    """엔티티 서브그래프에 object_links(부서 등 system 객체)를 1-hop 노드로 얹는다
    (A0.3 스텝3 A1). system 은 terminal — 재귀 확장 없이 각 엔티티 노드의 나가는
    링크만 붙인다. system 노드 id 는 `type:id` 문자열(엔티티 정수 id 와 충돌 없음),
    `kind='system'` + ref/url 로 프론트가 다른 목적지로 이동한다."""
    added: dict = {}
    for n in list(data.get("nodes", [])):
        outgoing, _ = services.list_object_links_for_ref(
            db, n["type_slug"], str(n["id"])
        )
        for link in outgoing:
            other = services.resolve_object(db, link.dst_type, link.dst_id)
            if not other:
                continue
            key = f"{other['type']}:{other['id']}"
            if key not in added:
                added[key] = {
                    "id": key,
                    "value": other["label"],
                    "type_slug": other["type"],
                    "type_id": None,
                    "kind": "system",
                    "ref_type": other["type"],
                    "ref_id": other["id"],
                    "url": other.get("url"),
                }
            data["edges"].append(
                {"src": n["id"], "dst": key, "relation": link.relation}
            )
    data["nodes"].extend(added.values())


@entities_router.post("/bulk-delete")
def bulk_delete_entities(
    payload: EntityBulkDeleteRequest,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """여러 엔티티를 한 번에 삭제(관리자만). 사용 중이라 개별 삭제가 막히는 값은
    건너뛰고, 지운 것/건너뛴 것(사유 포함)을 나눠 돌려준다(부분 성공). 개별
    delete_entity 를 그대로 재사용하므로 사용-중 가드가 동일하게 적용된다."""
    _require_admin(actor)
    deleted_ids: list[int] = []
    skipped: list[EntityBulkDeleteSkipped] = []
    seen: set[int] = set()
    for entity_id in payload.entity_ids:
        if entity_id in seen:  # 중복 id 는 한 번만 처리.
            continue
        seen.add(entity_id)
        row = services.get_entity(db, entity_id)
        if not row:
            skipped.append(
                EntityBulkDeleteSkipped(
                    id=entity_id, value=str(entity_id), reason="찾을 수 없음"
                )
            )
            continue
        try:
            services.delete_entity(db, row)
            deleted_ids.append(entity_id)
        except ValueError as exc:
            skipped.append(
                EntityBulkDeleteSkipped(id=entity_id, value=row.value, reason=str(exc))
            )
    return success_response(
        data=EntityBulkDeleteResponse(deleted_ids=deleted_ids, skipped=skipped),
        message=f"{len(deleted_ids)}건 삭제됨"
        + (f", {len(skipped)}건 건너뜀" if skipped else "") + ".",
    )


@entities_router.post("/bulk-reassign-axis")
def bulk_reassign_axis(
    payload: EntityReassignAxisRequest,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """선택한 엔티티들을 다른 축으로 이관(관리자만). 태깅은 entity_id 기준이라
    자동으로 따라온다. 대상 축에 같은 값이 이미 있으면 그 값으로 머지(원본
    삭제), 없으면 축만 바꿔 이사. 형식 불일치·없는 id 는 사유와 함께 건너뛴다."""
    _require_admin(actor)
    target = services.get_type(db, payload.target_type_id)
    if target is None:
        return error_response(
            f"대상 축을 찾을 수 없습니다: {payload.target_type_id}", status_code=400
        )
    if target.kind_class == "system":
        return error_response(
            "system 축으로는 값을 이관할 수 없습니다.", status_code=400
        )

    moved_ids: list[int] = []
    merged_ids: list[int] = []
    skipped: list[EntityBulkDeleteSkipped] = []
    seen: set[int] = set()
    for entity_id in payload.entity_ids:
        if entity_id in seen:
            continue
        seen.add(entity_id)
        row = services.get_entity(db, entity_id)
        if row is None:
            skipped.append(
                EntityBulkDeleteSkipped(
                    id=entity_id, value=str(entity_id), reason="찾을 수 없음"
                )
            )
            continue
        if row.type_id == target.id:
            skipped.append(
                EntityBulkDeleteSkipped(
                    id=entity_id, value=row.value, reason="이미 대상 축입니다"
                )
            )
            continue
        try:
            action, _into = services.reassign_entity_axis(
                db, entity=row, target_type=target, moved_by_user_id=actor.user.id
            )
        except ValueError as exc:
            skipped.append(
                EntityBulkDeleteSkipped(id=entity_id, value=row.value, reason=str(exc))
            )
            continue
        if action == "merged":
            merged_ids.append(entity_id)
        else:  # moved
            moved_ids.append(entity_id)

    parts = []
    if moved_ids:
        parts.append(f"{len(moved_ids)}건 이동")
    if merged_ids:
        parts.append(f"{len(merged_ids)}건 병합")
    if skipped:
        parts.append(f"{len(skipped)}건 건너뜀")
    return success_response(
        data=EntityReassignAxisResponse(
            moved_ids=moved_ids, merged_ids=merged_ids, skipped=skipped
        ),
        message=(", ".join(parts) + "." if parts else "이관할 항목이 없습니다."),
    )


@entities_router.delete("/{entity_id}")
def delete_entity(
    entity_id: int,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """Hard delete. Blocked when the entity is in use — the route
    surfaces a 400 so the admin can pick merge/deprecate instead."""
    _require_admin(actor)
    row = services.get_entity(db, entity_id)
    if not row:
        return not_found_response(f"엔티티를 찾을 수 없습니다: {entity_id}")
    name = row.value
    try:
        services.delete_entity(db, row)
    except ValueError as exc:
        return error_response(str(exc), status_code=400)
    return success_response(data=None, message=f"'{name}' 삭제 완료.")


# --------------------------------------------------------------------------- #
# objects router — `/api/objects` (ObjectRef 해석, A0.3 스텝2)
# --------------------------------------------------------------------------- #
objects_router = APIRouter()


@objects_router.get("/{obj_type}/{obj_id}")
def resolve_object_ref(
    obj_type: str,
    obj_id: str,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """어떤 종류 객체든 균일한 표시형(ObjectRef)으로 해석 — 인증-only. 그래프·
    프로필이 종류 안 가리고 노드/칩을 그리는 통합 진입점. 모르는 타입/대상은 404.
    report 는 요청자 가시성 게이트(actor.user)."""
    ref = services.resolve_object(db, obj_type, obj_id, actor.user)
    if ref is None:
        return not_found_response(f"객체를 찾을 수 없습니다: {obj_type}/{obj_id}")
    return success_response(data=ObjectRefRead(**ref))


@objects_router.get("/{obj_type}/{obj_id}/links")
def object_ref_links(
    obj_type: str,
    obj_id: str,
    actor: EntityActor = Depends(entity_actor),
    db: Session = Depends(get_db),
):
    """이 객체의 링크(양방향, 해석됨) — 인증-only. 수동 object_links + **FK 파생 관계**
    (report 작성자·부서·다룬 객체, user 소속·작성 보고서)를 합쳐 돌려준다. 부서(dept)로
    부르면 incoming 이 '이 부서가 담당한 과제들'. report 는 가시성 게이트(actor.user)."""
    ref = services.resolve_object(db, obj_type, obj_id, actor.user)
    if ref is None:
        return not_found_response(f"객체를 찾을 수 없습니다: {obj_type}/{obj_id}")
    outgoing, incoming = services.list_object_links_for_ref(db, obj_type, obj_id)
    cache: dict = {}
    items: list[ObjectLinkItem] = []
    for link in outgoing:
        other = services.resolve_object(db, link.dst_type, link.dst_id, actor.user)
        if other:
            items.append(_object_link_item(db, link, "out", other, cache))
    for link in incoming:
        other = services.resolve_object(db, link.src_type, link.src_id, actor.user)
        if other:
            items.append(_object_link_item(db, link, "in", other, cache))
    derived = services.derived_links_for(db, actor.user, obj_type, obj_id)
    return success_response(
        data={"object": ObjectRefRead(**ref), "items": items, "derived": derived}
    )
