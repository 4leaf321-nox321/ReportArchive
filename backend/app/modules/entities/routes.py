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

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.entities import graph, merge_candidates, services
from app.modules.entities.schemas import (
    EntityAliasCreate,
    EntityAliasListResponse,
    EntityAliasRead,
    EntityCreate,
    EntityListResponse,
    EntityMergeDismissRequest,
    EntityMergeRequest,
    EntityRead,
    EntityRelationCreate,
    EntityRelationItem,
    EntityRelationsResponse,
    EntityTypeCreate,
    EntityTypeListResponse,
    EntityTypeRead,
    EntityTypeUpdate,
    EntityUpdate,
    EntityUsageReportRef,
    EntityUsageResponse,
    EntityYearsResponse,
    EntityYearsUpdate,
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


def _relation_item(counterpart, rel) -> EntityRelationItem:
    """관계 행 + 상대 엔티티 → 응답 아이템."""
    return EntityRelationItem(
        relation_id=rel.id,
        relation=rel.relation,
        entity_id=counterpart.id,
        value=counterpart.value,
        type_id=counterpart.type_id,
        type_slug=counterpart.entity_type.slug if counterpart.entity_type else "",
        code=counterpart.code,
    )


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
    parents, children = services.list_relations(db, entity_id=entity_id)
    parent_items = []
    for r in parents:
        cp = services.get_entity(db, r.dst_entity_id)
        if cp:
            parent_items.append(_relation_item(cp, r))
    child_items = []
    for r in children:
        cp = services.get_entity(db, r.src_entity_id)
        if cp:
            child_items.append(_relation_item(cp, r))
    return success_response(
        data=EntityRelationsResponse(parents=parent_items, children=child_items)
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
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=_relation_item(dst, rel))


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
    return success_response(data=data)


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
