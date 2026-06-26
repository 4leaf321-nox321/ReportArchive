"""Business logic for the entity tagging module.

Two separate concerns kept in one file because they share the same
models:
  - CRUD on EntityType / Entity (picker + admin)
  - Replace-style writes on the report ↔ entity link table
    (called from `app.modules.reports.services` when a report is saved)
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.modules.entities import graph
from app.modules.entities.models import (
    RELATION_PART_OF,
    Entity,
    EntityAlias,
    EntityEntryPolicy,
    EntityRelation,
    EntityStatus,
    EntityType,
    RelationType,
    ReportEntity,
)
from app.modules.entities.schemas import (
    EntityCreate,
    EntityTypeCreate,
    EntityTypeUpdate,
    EntityUpdate,
    RelationTypeCreate,
    RelationTypeUpdate,
)

import re


# --------------------------------------------------------------------------- #
# EntityType — read-only from the API (system-managed via migration seeds)
# --------------------------------------------------------------------------- #
def list_types(db: Session) -> list[EntityType]:
    """All axes ordered by sort_order then label. Seeded set is small
    (~7) so no pagination."""
    return list(
        db.execute(
            select(EntityType).order_by(EntityType.sort_order, EntityType.label)
        ).scalars()
    )


def get_type(db: Session, type_id: int) -> Optional[EntityType]:
    return db.get(EntityType, type_id)


def get_type_by_slug(db: Session, slug: str) -> Optional[EntityType]:
    return db.execute(
        select(EntityType).where(EntityType.slug == slug)
    ).scalar_one_or_none()


# Slug 형식: 소문자/숫자/언더스코어/대시만. seeded 축들이 모두 따르는
# 관례라 신규 축도 같은 규칙. 길이 한계는 schema 가 1..32 로 잡음.
_SLUG_RE = re.compile(r"^[a-z0-9_-]+$")


def create_type(db: Session, payload: EntityTypeCreate) -> EntityType:
    """Admin-only — add a new axis. Caller (route) enforces the role
    check. Slug clashes raise ValueError so the route can surface 400.
    `sort_order` defaults to max+1 (end of strip) when caller didn't set."""
    slug = payload.slug.strip().lower()
    if not _SLUG_RE.fullmatch(slug):
        raise ValueError(
            "slug 는 소문자·숫자·언더스코어(_)·대시(-) 만 사용할 수 있습니다."
        )
    if get_type_by_slug(db, slug) is not None:
        raise ValueError(f"이미 같은 slug 의 축이 있습니다: {slug}")

    label = payload.label.strip()
    if not label:
        raise ValueError("라벨은 비워둘 수 없습니다.")

    if payload.sort_order is None:
        current_max = (
            db.execute(select(func.coalesce(func.max(EntityType.sort_order), 0))).scalar()
            or 0
        )
        sort_order = int(current_max) + 1
    else:
        sort_order = int(payload.sort_order)

    row = EntityType(
        slug=slug,
        label=label,
        icon=(payload.icon or "").strip(),
        multi=bool(payload.multi),
        sort_order=sort_order,
        description=(payload.description or "").strip(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def update_type(db: Session, row: EntityType, payload: EntityTypeUpdate) -> EntityType:
    """Admin-only — 축의 입력 거버넌스(entry_policy·value_pattern) 수정.
    보낸 필드만 반영. value_pattern 은 빈 문자열로 보내면 제약 해제(None).
    잘못된 정규식은 ValueError 로 거부해 라우트가 400 으로 surface."""
    data = payload.model_dump(exclude_unset=True)

    if "entry_policy" in data and data["entry_policy"] is not None:
        row.entry_policy = data["entry_policy"]

    if "value_pattern" in data:
        raw = (data["value_pattern"] or "").strip()
        if raw:
            try:
                re.compile(raw)
            except re.error as exc:
                raise ValueError(f"올바르지 않은 정규식입니다: {exc}") from exc
            row.value_pattern = raw
        else:
            row.value_pattern = None

    db.commit()
    db.refresh(row)
    return row


def delete_type(db: Session, row: EntityType) -> int:
    """Hard-delete an axis. Blocked while the axis still has values — the
    DB-level ondelete=RESTRICT would also catch this, but we raise the
    friendlier ValueError up front so the route can surface a 400 with
    a count. Caller (route) enforces the admin role check.

    Returns the (now-deleted) row's id for parity with other delete_*
    helpers in this module.
    """
    in_use = (
        db.execute(
            select(func.count(Entity.id)).where(Entity.type_id == row.id)
        ).scalar()
        or 0
    )
    if in_use:
        raise ValueError(
            f"이 축에는 {in_use}건의 값이 등록되어 있습니다. "
            "축을 삭제하려면 모든 값을 먼저 삭제하거나 다른 축으로 옮겨 주세요."
        )
    removed_id = row.id
    db.delete(row)
    db.commit()
    return removed_id


# --------------------------------------------------------------------------- #
# Entity — picker reads + user/admin writes
# --------------------------------------------------------------------------- #
def find_by_value_ci(
    db: Session, *, type_id: int, value: str
) -> Optional[Entity]:
    """Case-insensitive lookup within one axis — prevents
    'A1234' / 'a1234' / '  A1234 ' style near-duplicates from being
    re-created when the picker calls POST optimistically."""
    needle = value.strip().lower()
    if not needle:
        return None
    return db.execute(
        select(Entity).where(
            Entity.type_id == type_id,
            func.lower(Entity.value) == needle,
        )
    ).scalar_one_or_none()


def _normalize(s: str) -> str:
    """별칭/값 비교용 정규화 — 앞뒤 공백 제거 + 소문자."""
    return (s or "").strip().lower()


def find_by_alias(db: Session, *, type_id: int, value: str) -> Optional[Entity]:
    """입력값을 별칭 테이블에서 찾아 canonical 엔티티로 resolve. 같은 축
    안에서 (type_id, normalized) 가 유니크라 매칭은 최대 1건."""
    needle = _normalize(value)
    if not needle:
        return None
    alias = db.execute(
        select(EntityAlias).where(
            EntityAlias.type_id == type_id,
            EntityAlias.normalized == needle,
        )
    ).scalar_one_or_none()
    if alias is None:
        return None
    return db.get(Entity, alias.entity_id)


def resolve_existing(db: Session, *, type_id: int, value: str) -> Optional[Entity]:
    """입력값 → 기존 엔티티 resolve. 값 자체 매칭(대소문자 무시) 우선, 없으면
    별칭으로 흡수. 둘 다 없으면 None(=신규 후보)."""
    hit = find_by_value_ci(db, type_id=type_id, value=value)
    if hit is not None:
        return hit
    return find_by_alias(db, type_id=type_id, value=value)


def value_matches_pattern(pattern: Optional[str], value: str) -> bool:
    """value_pattern(정규식, fullmatch)로 값 형식 검증. 패턴이 없으면 항상 통과.
    저장된 패턴은 update_type 에서 이미 compile 검증을 거쳤다."""
    if not pattern:
        return True
    try:
        return re.fullmatch(pattern, value) is not None
    except re.error:
        # 저장 시 검증을 통과했으므로 정상 경로에선 도달하지 않지만, 손상된
        # 패턴이 있어도 입력을 막지 않도록 안전하게 통과시킨다.
        return True


def _related_to_subquery(related_to: list[int]):
    """related_to(부모 id 들)에 part_of 로 묶인 자식 엔티티 id 서브쿼리.
    캐스케이드 picker 가 "선택한 모델의 부품만" 같은 좁힘에 쓴다."""
    return select(EntityRelation.src_entity_id).where(
        EntityRelation.dst_entity_id.in_(related_to),
        EntityRelation.relation == RELATION_PART_OF,
    )


def list_entities(
    db: Session,
    *,
    type_id: Optional[int] = None,
    q: Optional[str] = None,
    include_deprecated: bool = False,
    limit: int = 200,
    with_usage: bool = False,
    related_to: Optional[list[int]] = None,
) -> list[Entity] | list[tuple[Entity, int]]:
    """Picker list — filters on axis + search + (optionally) status.

    `include_deprecated=False` is the picker default so deprecated values
    drop out of the dropdown but stay viewable on the admin page
    (which sends `True` to see the full set).

    `with_usage=True` makes the admin variant: each row is paired with
    the number of reports currently linked to it. Returned as
    `[(Entity, count)]` so the route can pack it into `EntityRead.usage_count`.
    Picker calls leave this False — the extra LEFT JOIN COUNT is only
    worth it for the admin grid's "사용 중" column.
    """
    if not with_usage:
        stmt = select(Entity)
        if type_id is not None:
            stmt = stmt.where(Entity.type_id == type_id)
        if not include_deprecated:
            stmt = stmt.where(Entity.status == EntityStatus.active)
        if q:
            needle = f"%{q.strip().lower()}%"
            stmt = stmt.where(
                or_(
                    func.lower(Entity.value).like(needle),
                    func.lower(Entity.code).like(needle),
                    func.lower(Entity.description).like(needle),
                )
            )
        if related_to:
            stmt = stmt.where(Entity.id.in_(_related_to_subquery(related_to)))
        stmt = stmt.order_by(Entity.value).limit(limit)
        return list(db.execute(stmt).scalars())

    # Admin variant — count via a correlated subquery rather than
    # LEFT JOIN + GROUP BY. The join approach trips over Entity's
    # eager-loaded relationships (entity_type, created_by): Postgres
    # demands every selected column appear in GROUP BY. A correlated
    # subquery keeps Entity rows whole and leaves the eager loads
    # untouched; cost is one indexed lookup per row (the entity_id
    # index on report_entities), which stays well under a ms for the
    # admin list's ~hundreds of rows.
    count_subq = (
        select(func.count(ReportEntity.report_id))
        .where(ReportEntity.entity_id == Entity.id)
        .correlate(Entity)
        .scalar_subquery()
    )
    stmt = select(Entity, count_subq)
    if type_id is not None:
        stmt = stmt.where(Entity.type_id == type_id)
    if not include_deprecated:
        stmt = stmt.where(Entity.status == EntityStatus.active)
    if q:
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(Entity.value).like(needle),
                func.lower(Entity.code).like(needle),
                func.lower(Entity.description).like(needle),
            )
        )
    if related_to:
        stmt = stmt.where(Entity.id.in_(_related_to_subquery(related_to)))
    stmt = stmt.order_by(Entity.value).limit(limit)
    return [(row, int(cnt or 0)) for row, cnt in db.execute(stmt).all()]


def get_entity(db: Session, entity_id: int) -> Optional[Entity]:
    return db.get(Entity, entity_id)


def list_by_ids(db: Session, ids: list[int]) -> list[Entity]:
    """Bulk lookup used by reports/services.py when validating the
    `entity_ids` payload on a report save."""
    if not ids:
        return []
    return list(
        db.execute(select(Entity).where(Entity.id.in_(set(ids)))).scalars()
    )


def create_entity(
    db: Session, payload: EntityCreate, *, creator_user_id: int
) -> Entity:
    """Any authenticated user can create. New rows land as `active`
    immediately — the admin reviews/merges drift through the admin page
    (no pending-approval state, by deliberate design: it would block the
    picker UX and the dataset is small enough to clean up periodically).
    """
    type_row = get_type(db, payload.type_id)
    if type_row is None:
        raise ValueError(f"엔티티 타입을 찾을 수 없습니다: {payload.type_id}")

    value = payload.value.strip()
    if not value:
        raise ValueError("값은 비워둘 수 없습니다.")

    # 거버넌스 게이트 (p53):
    #   1) 기존 값/별칭으로 resolve 되면 그 canonical 을 반환(신규 생성 안 함).
    #      picker 가 optimistic POST 하므로 409 대신 정규 행을 돌려준다.
    existing = resolve_existing(db, type_id=payload.type_id, value=value)
    if existing is not None:
        return existing

    #   2) closed 축은 사용자 즉석 추가 차단(관리자가 등록한 값만 선택 가능).
    if type_row.entry_policy == EntityEntryPolicy.closed:
        raise ValueError(
            f"'{type_row.label}' 은(는) 관리자가 등록한 값만 선택할 수 있습니다."
        )

    #   3) value_pattern 이 있으면 형식 검증.
    if not value_matches_pattern(type_row.value_pattern, value):
        raise ValueError(
            f"'{type_row.label}' 형식에 맞지 않는 값입니다 "
            f"(패턴: {type_row.value_pattern})."
        )

    code = (payload.code or "").strip() or None
    row = Entity(
        type_id=payload.type_id,
        value=value,
        code=code,
        description=(payload.description or "").strip(),
        status=EntityStatus.active,
        created_by_user_id=creator_user_id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def update_entity(db: Session, row: Entity, payload: EntityUpdate) -> Entity:
    """Admin-only mutations. The route layer enforces the role check —
    this function trusts the caller."""
    data = payload.model_dump(exclude_unset=True)

    if "value" in data and data["value"] is not None:
        new_value = data["value"].strip()
        if not new_value:
            raise ValueError("값은 비워둘 수 없습니다.")
        # Re-check uniqueness within the same axis on rename, excluding
        # the row being edited.
        clash = db.execute(
            select(Entity).where(
                Entity.type_id == row.type_id,
                func.lower(Entity.value) == new_value.lower(),
                Entity.id != row.id,
            )
        ).scalar_one_or_none()
        if clash is not None:
            raise ValueError(f"이미 같은 값이 있습니다: {clash.value}")
        row.value = new_value

    if "code" in data:
        row.code = (data["code"] or "").strip() or None
    if "description" in data and data["description"] is not None:
        row.description = data["description"].strip()
    if "status" in data and data["status"] is not None:
        row.status = data["status"]

    db.commit()
    db.refresh(row)
    return row


def merge_entities(
    db: Session, *, src: Entity, into: Entity
) -> int:
    """Re-link all `report_entities` rows from `src` to `into`, drop `src`,
    return the number of reports re-linked.

    Caller (route) must have admin role. Both entities must live on the
    same axis — merging across axes would change a report's meaning, not
    just dedupe a value. If `into` is already linked to a report that
    `src` is also linked to, the duplicate link is silently dropped
    (composite PK on report_entities).
    """
    if src.id == into.id:
        return 0
    if src.type_id != into.type_id:
        raise ValueError("같은 타입(축)의 엔티티끼리만 머지할 수 있습니다.")

    # Walk reports holding `src` and re-point them to `into`. Doing this
    # row-by-row (rather than a single UPDATE) lets us swallow the
    # composite-PK conflict per row when the target report already holds
    # `into` — equivalent to "if both exist, keep one".
    src_links = list(
        db.execute(
            select(ReportEntity).where(ReportEntity.entity_id == src.id)
        ).scalars()
    )
    relinked = 0
    for link in src_links:
        already = db.execute(
            select(ReportEntity).where(
                ReportEntity.report_id == link.report_id,
                ReportEntity.entity_id == into.id,
            )
        ).scalar_one_or_none()
        if already is not None:
            db.delete(link)
            continue
        # Insert the new link first, then drop the old — keeps the report
        # tagged at every step (avoids a momentary "no tag" window
        # visible to a concurrent reader).
        db.add(ReportEntity(report_id=link.report_id, entity_id=into.id))
        db.delete(link)
        relinked += 1

    # 별칭 흡수 (p53) — 머지 효과를 영속화한다. src 의 별칭들을 into 로 옮기고,
    # src 의 값 자체도 into 의 별칭으로 등록 → 이후 옛 표기 입력이 자동으로
    # into 로 빨려 들어간다. (type_id, normalized) 충돌은 버린다.
    def _norm_taken(norm: str) -> bool:
        return (
            db.execute(
                select(EntityAlias).where(
                    EntityAlias.type_id == into.type_id,
                    EntityAlias.normalized == norm,
                )
            ).scalar_one_or_none()
            is not None
        )

    for a in list(
        db.execute(
            select(EntityAlias).where(EntityAlias.entity_id == src.id)
        ).scalars()
    ):
        if a.entity_id == into.id:
            continue
        if _norm_taken(a.normalized):
            db.delete(a)
        else:
            a.entity_id = into.id  # 같은 축이라 type_id 그대로
            db.flush()  # 다음 _norm_taken 이 이 행을 보도록 즉시 반영
    src_val_norm = _normalize(src.value)
    if (
        src_val_norm
        and src_val_norm != _normalize(into.value)
        and not _norm_taken(src_val_norm)
    ):
        db.add(
            EntityAlias(
                entity_id=into.id,
                type_id=into.type_id,
                alias=src.value,
                normalized=src_val_norm,
            )
        )

    # 관계 이관 (p54) — src 의 part_of 관계(부모/자식 양쪽)를 into 로 옮긴다.
    # into 로 옮겼을 때 자기참조가 되거나(상대가 into) 이미 같은 관계가 있으면
    # 버린다.
    def _rel_exists(s: int, d: int, rel: str) -> bool:
        return (
            db.execute(
                select(EntityRelation).where(
                    EntityRelation.src_entity_id == s,
                    EntityRelation.dst_entity_id == d,
                    EntityRelation.relation == rel,
                )
            ).scalar_one_or_none()
            is not None
        )

    for r in list(
        db.execute(
            select(EntityRelation).where(EntityRelation.src_entity_id == src.id)
        ).scalars()
    ):
        if r.dst_entity_id == into.id or _rel_exists(
            into.id, r.dst_entity_id, r.relation
        ):
            db.delete(r)
        else:
            r.src_entity_id = into.id
        db.flush()
    for r in list(
        db.execute(
            select(EntityRelation).where(EntityRelation.dst_entity_id == src.id)
        ).scalars()
    ):
        if r.src_entity_id == into.id or _rel_exists(
            r.src_entity_id, into.id, r.relation
        ):
            db.delete(r)
        else:
            r.dst_entity_id = into.id
        db.flush()

    db.flush()
    db.delete(src)
    db.commit()
    return relinked


def delete_entity(db: Session, row: Entity) -> int:
    """Hard delete — only allowed when no reports reference the entity.
    Returns 0 on success (no orphans). Raises ValueError when in use so
    the caller can surface the "use merge or deprecate instead" message.
    """
    in_use = (
        db.execute(
            select(func.count(ReportEntity.report_id)).where(
                ReportEntity.entity_id == row.id
            )
        ).scalar()
        or 0
    )
    if in_use:
        raise ValueError(
            f"이 값은 {in_use}건의 보고서가 사용 중입니다. "
            "머지하거나 비활성화(deprecate) 하세요."
        )
    db.delete(row)
    db.commit()
    return 0


# --------------------------------------------------------------------------- #
# Entity aliases — 표기 통일(자동 흡수). admin 관리, picker 입력 시 resolve.
# --------------------------------------------------------------------------- #
def list_aliases(db: Session, *, entity_id: int) -> list[EntityAlias]:
    return list(
        db.execute(
            select(EntityAlias)
            .where(EntityAlias.entity_id == entity_id)
            .order_by(EntityAlias.alias)
        ).scalars()
    )


def get_alias(db: Session, alias_id: int) -> Optional[EntityAlias]:
    return db.get(EntityAlias, alias_id)


def add_alias(
    db: Session, *, entity: Entity, alias: str, creator_user_id: Optional[int] = None
) -> EntityAlias:
    """엔티티에 별칭(다른 표기)을 단다. 같은 축 안에서 충돌(다른 값과 동일,
    다른 값의 별칭과 동일)하면 거부. 이미 이 엔티티의 별칭이면 멱등 반환."""
    text = alias.strip()
    if not text:
        raise ValueError("별칭은 비워둘 수 없습니다.")
    norm = _normalize(text)
    if norm == _normalize(entity.value):
        raise ValueError("값 자체와 동일한 표기는 별칭으로 등록할 필요가 없습니다.")

    # 같은 축의 다른 '값' 과 충돌 — 그 표기는 이미 독립된 값이라 별칭화 불가.
    clash_value = find_by_value_ci(db, type_id=entity.type_id, value=text)
    if clash_value is not None and clash_value.id != entity.id:
        raise ValueError(
            f"같은 축에 이미 '{clash_value.value}' 값이 있어 별칭으로 쓸 수 없습니다 "
            "(필요하면 머지하세요)."
        )

    existing = db.execute(
        select(EntityAlias).where(
            EntityAlias.type_id == entity.type_id,
            EntityAlias.normalized == norm,
        )
    ).scalar_one_or_none()
    if existing is not None:
        if existing.entity_id == entity.id:
            return existing  # 멱등
        raise ValueError("이미 같은 축의 다른 값에 등록된 표기입니다.")

    row = EntityAlias(
        entity_id=entity.id,
        type_id=entity.type_id,
        alias=text,
        normalized=norm,
        created_by_user_id=creator_user_id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def delete_alias(db: Session, row: EntityAlias) -> int:
    db.delete(row)
    db.commit()
    return 0


# --------------------------------------------------------------------------- #
# Entity relations — 계층/관계(part_of). 캐스케이드 picker·롤업의 토대.
# --------------------------------------------------------------------------- #
def _ancestors_up(
    db: Session, *, start_id: int, relation: str, max_depth: int = 20
) -> set[int]:
    """start 에서 relation 을 따라 위(부모/조상)로 올라가며 만나는 모든 조상 id.
    add_relation 의 사이클 가드용. graph.reachable(out) 에 위임(재귀 CTE)."""
    return graph.reachable(
        db, [start_id], relations=[relation], direction="out", max_depth=max_depth
    )


# --------------------------------------------------------------------------- #
# RelationType — 엣지 종류 레지스트리 (p55). admin 관리.
# --------------------------------------------------------------------------- #
def list_relation_types(db: Session) -> list[RelationType]:
    return list(
        db.execute(
            select(RelationType).order_by(
                RelationType.sort_order, RelationType.slug
            )
        ).scalars()
    )


def get_relation_type(db: Session, slug: str) -> Optional[RelationType]:
    return db.execute(
        select(RelationType).where(RelationType.slug == slug)
    ).scalar_one_or_none()


def create_relation_type(db: Session, payload: RelationTypeCreate) -> RelationType:
    if get_relation_type(db, payload.slug) is not None:
        raise ValueError(f"이미 존재하는 관계 종류입니다: {payload.slug}")
    row = RelationType(
        slug=payload.slug,
        label=payload.label,
        inverse_label=payload.inverse_label or "",
        directed=payload.directed,
        transitive=payload.transitive,
        acyclic=payload.acyclic,
        src_axis_slugs=payload.src_axis_slugs or None,
        dst_axis_slugs=payload.dst_axis_slugs or None,
        sort_order=payload.sort_order,
        description=payload.description or "",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def update_relation_type(
    db: Session, row: RelationType, payload: RelationTypeUpdate
) -> RelationType:
    """메타 갱신. slug 는 불변(엔티티 관계들이 가리키는 키라 바꾸면 끊어짐)."""
    data = payload.model_dump(exclude_unset=True)
    for field in (
        "label",
        "inverse_label",
        "directed",
        "transitive",
        "acyclic",
        "sort_order",
        "description",
    ):
        if field in data and data[field] is not None:
            setattr(row, field, data[field])
    # 축 제약은 명시적으로 빈 리스트/None 을 보내 '제약 없음'으로 풀 수 있어야 하므로
    # exclude_unset 으로 키 존재 여부만 본다([] → None 으로 저장 = 제약 해제).
    if "src_axis_slugs" in data:
        row.src_axis_slugs = data["src_axis_slugs"] or None
    if "dst_axis_slugs" in data:
        row.dst_axis_slugs = data["dst_axis_slugs"] or None
    db.commit()
    db.refresh(row)
    return row


def delete_relation_type(db: Session, row: RelationType) -> int:
    """삭제. 이미 그 타입을 쓰는 엔티티 관계가 있으면 거부(데이터 고아 방지) —
    먼저 관계들을 정리/이관해야 한다."""
    in_use = db.scalar(
        select(func.count())
        .select_from(EntityRelation)
        .where(EntityRelation.relation == row.slug)
    )
    if in_use:
        raise ValueError(
            f"이 관계 종류를 사용하는 관계가 {in_use}건 있어 삭제할 수 없습니다."
        )
    removed_id = row.id
    db.delete(row)
    db.commit()
    return removed_id


def add_relation(
    db: Session,
    *,
    src: Entity,
    dst: Entity,
    relation: str = RELATION_PART_OF,
    creator_user_id: Optional[int] = None,
) -> EntityRelation:
    """src --relation--> dst 추가. 관계 종류는 relation_types 레지스트리(p55)에서
    조회·검증한다 — 허용 타입인지, 축 제약(src_axis_slugs/dst_axis_slugs)에 맞는지,
    acyclic 타입이면 순환이 안 되는지. 자기참조·중복도 막는다. 이미 있으면 멱등 반환."""
    rtype = get_relation_type(db, relation)
    if rtype is None:
        raise ValueError(f"지원하지 않는 관계 종류입니다: {relation}")
    if src.id == dst.id:
        raise ValueError("자기 자신과는 관계를 맺을 수 없습니다.")

    # 축 제약 — 타입이 허용 축을 지정했으면 src/dst 의 축이 그 안이어야 한다.
    src_slug = src.entity_type.slug if src.entity_type else None
    dst_slug = dst.entity_type.slug if dst.entity_type else None
    if rtype.src_axis_slugs and src_slug not in rtype.src_axis_slugs:
        raise ValueError(
            f"'{rtype.label}' 관계의 출발 축이 아닙니다(허용: {', '.join(rtype.src_axis_slugs)})."
        )
    if rtype.dst_axis_slugs and dst_slug not in rtype.dst_axis_slugs:
        raise ValueError(
            f"'{rtype.label}' 관계의 도착 축이 아닙니다(허용: {', '.join(rtype.dst_axis_slugs)})."
        )

    existing = db.execute(
        select(EntityRelation).where(
            EntityRelation.src_entity_id == src.id,
            EntityRelation.dst_entity_id == dst.id,
            EntityRelation.relation == relation,
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    # 순환 가드는 acyclic 타입만(part_of·supersedes 등). 비acyclic 타입(tested_by 등)은
    # 애초에 계층이 아니라 순환 개념이 없어 가드를 건너뛴다.
    if rtype.acyclic and src.id in _ancestors_up(db, start_id=dst.id, relation=relation):
        raise ValueError("순환 관계가 되어 추가할 수 없습니다.")

    row = EntityRelation(
        src_entity_id=src.id,
        dst_entity_id=dst.id,
        relation=relation,
        created_by_user_id=creator_user_id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def get_relation(db: Session, relation_id: int) -> Optional[EntityRelation]:
    return db.get(EntityRelation, relation_id)


def list_relations(
    db: Session, *, entity_id: int, relation: Optional[str] = None
) -> tuple[list[EntityRelation], list[EntityRelation]]:
    """(outgoing, incoming). outgoing = 이 엔티티가 src 인 관계(this --rel--> X),
    incoming = 이 엔티티가 dst 인 관계(X --rel--> this).

    `relation=None`(기본) 이면 **모든 관계 종류**를 반환 — 관리 화면이 타입별로
    묶어 보여준다. 특정 slug 를 주면 그 종류만(롤업·캐스케이드 내부용)."""
    out_q = select(EntityRelation).where(EntityRelation.src_entity_id == entity_id)
    in_q = select(EntityRelation).where(EntityRelation.dst_entity_id == entity_id)
    if relation is not None:
        out_q = out_q.where(EntityRelation.relation == relation)
        in_q = in_q.where(EntityRelation.relation == relation)
    outgoing = list(db.execute(out_q).scalars())
    incoming = list(db.execute(in_q).scalars())
    return outgoing, incoming


def delete_relation(db: Session, row: EntityRelation) -> int:
    db.delete(row)
    db.commit()
    return 0


def get_descendant_entity_ids(
    db: Session,
    *,
    root_ids,
    relation: str = RELATION_PART_OF,
    max_depth: int = 20,
) -> set[int]:
    """root_ids 에서 relation 을 따라 아래(자식)로 내려가며 만나는 모든 자손 id
    (root 자신은 미포함). 롤업 필터에서 '부모로 필터하면 자식 태그도 포함'에
    쓴다. graph.reachable(in) 에 위임(재귀 CTE)."""
    return graph.reachable(
        db, root_ids, relations=[relation], direction="in", max_depth=max_depth
    )


def expand_with_descendants(
    db: Session, *, entity_ids, relation: str = RELATION_PART_OF
) -> list[int]:
    """주어진 id 집합 ∪ 그 자손들. 롤업 — 부모로 필터하면 자식 태그 보고서까지
    포함된다. 관계가 없으면 원본 그대로(현행 동작)."""
    base = {int(x) for x in entity_ids}
    if not base:
        return []
    return list(base | get_descendant_entity_ids(db, root_ids=base, relation=relation))


# --------------------------------------------------------------------------- #
# Report ↔ Entity link writes — called from reports/services.py on save
# --------------------------------------------------------------------------- #
def set_report_entities(
    db: Session, *, report_id: int, entity_ids: list[int]
) -> list[Entity]:
    """Replace the full set of entity links for a report.

    The reports service routes here when a save payload contains an
    `entity_ids` array. Validates every id resolves to an active or
    deprecated row (the latter is OK — a report keeps a deprecated tag
    until the user clears it), then rewrites the link table in one
    flush.

    No-op when the new set equals the existing set (skips the
    delete/insert churn so saves don't dirty `updated_at`-style
    audit fields downstream — Report itself owns its updated_at).
    """
    target_ids = list({int(eid) for eid in entity_ids})
    rows = list_by_ids(db, target_ids)
    found_ids = {r.id for r in rows}
    missing = [eid for eid in target_ids if eid not in found_ids]
    if missing:
        raise ValueError(f"존재하지 않는 엔티티 id: {missing}")

    existing_links = list(
        db.execute(
            select(ReportEntity).where(ReportEntity.report_id == report_id)
        ).scalars()
    )
    existing_ids = {link.entity_id for link in existing_links}
    if existing_ids == set(target_ids):
        return rows

    for link in existing_links:
        if link.entity_id not in target_ids:
            db.delete(link)
    for eid in target_ids:
        if eid not in existing_ids:
            db.add(ReportEntity(report_id=report_id, entity_id=eid))
    try:
        db.flush()
    except IntegrityError as exc:
        # Composite PK violation = duplicate id in the payload that the
        # set() above should already have collapsed; defense in depth.
        db.rollback()
        raise ValueError(f"중복 엔티티 id: {exc}") from exc

    return rows


def get_report_entities(db: Session, report_id: int) -> list[Entity]:
    """Read-side helper for the few code paths that touch a report by
    id without going through the ORM relationship (e.g. background jobs).
    Routes / API responses use the eager-loaded `Report.entities` relationship."""
    stmt = (
        select(Entity)
        .join(ReportEntity, ReportEntity.entity_id == Entity.id)
        .where(ReportEntity.report_id == report_id)
        .order_by(Entity.value)
    )
    return list(db.execute(stmt).scalars())


def unlink_from_report(db: Session, *, entity_id: int, report_id: int) -> bool:
    """Drop a single (report_id, entity_id) link from the M:N table.

    Returns True when a link was removed, False when none existed (caller
    treats absent as 200 idempotent — the desired end state already holds).
    Used by the admin page's per-report × in the usage popover for
    surgical fixes ("this one report has the wrong tag").
    """
    link = db.execute(
        select(ReportEntity).where(
            ReportEntity.entity_id == entity_id,
            ReportEntity.report_id == report_id,
        )
    ).scalar_one_or_none()
    if link is None:
        return False
    db.delete(link)
    db.commit()
    return True


def unlink_from_all_reports(db: Session, *, entity_id: int) -> int:
    """Drop every link this entity has across all reports — leaves the
    entity row itself untouched. Returns the number of links removed.

    Used by the admin's "모든 보고서에서 태그 해제" bulk action: after
    this runs the entity has usage 0 and can be hard-deleted, OR the
    admin can keep it around (e.g. wrong value to be re-attached later).
    Unlike merge, this does NOT re-route reports to a different value —
    they simply lose this axis tag entirely.
    """
    links = list(
        db.execute(
            select(ReportEntity).where(ReportEntity.entity_id == entity_id)
        ).scalars()
    )
    for link in links:
        db.delete(link)
    db.commit()
    return len(links)


def list_reports_using_entity(db: Session, *, entity_id: int) -> list:
    """Slim "어떤 보고서가 이 값을 쓰고 있나?" lookup for the admin page.

    Returns rows of (id, title, workspace_slug, updated_at) tuples ordered
    by most-recently-updated first. Workspace-agnostic by design — the
    admin needs to see ALL blockers regardless of their current
    workspace context (otherwise the delete dialog would silently
    under-report and the 400 from the actual delete attempt would
    surprise them).

    Imported lazily because the reports module imports from this one
    (entity_services.set_report_entities) and a top-level import would
    cycle.
    """
    from app.modules.reports.models import Report  # local to avoid cycle

    stmt = (
        select(Report.id, Report.title, Report.workspace_slug, Report.updated_at)
        .join(ReportEntity, ReportEntity.report_id == Report.id)
        .where(ReportEntity.entity_id == entity_id)
        .order_by(Report.updated_at.desc())
    )
    return list(db.execute(stmt).all())
