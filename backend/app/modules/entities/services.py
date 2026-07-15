"""Business logic for the entity tagging module.

Two separate concerns kept in one file because they share the same
models:
  - CRUD on EntityType / Entity (picker + admin)
  - Replace-style writes on the report ↔ entity link table
    (called from `app.modules.reports.services` when a report is saved)
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Float, and_, cast, delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.modules.entities import graph
from app.modules.entities.models import (
    RELATION_PART_OF,
    Entity,
    EntityAlias,
    EntityEntryPolicy,
    EntityMerge,
    EntityKindClass,
    EntityMergeDismissal,
    EntityRelation,
    EntityStatus,
    EntityTemporalKind,
    EntityType,
    EntityYear,
    ObjectLink,
    PropertyDef,
    RelationType,
    ReportEntity,
)
from app.modules.entities.schemas import (
    EntityCreate,
    EntityTypeCreate,
    EntityTypeUpdate,
    EntityUpdate,
    PropertyDefCreate,
    PropertyDefUpdate,
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
        kind_class=payload.kind_class,
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

    if "label" in data and data["label"] is not None:
        label = data["label"].strip()
        if not label:
            raise ValueError("라벨은 비워둘 수 없습니다.")
        row.label = label
    if "icon" in data and data["icon"] is not None:
        row.icon = data["icon"].strip()
    if "description" in data and data["description"] is not None:
        row.description = data["description"].strip()
    if "sort_order" in data and data["sort_order"] is not None:
        row.sort_order = int(data["sort_order"])

    if "entry_policy" in data and data["entry_policy"] is not None:
        row.entry_policy = data["entry_policy"]

    if "temporal_kind" in data and data["temporal_kind"] is not None:
        row.temporal_kind = data["temporal_kind"]

    if "kind_class" in data and data["kind_class"] is not None:
        row.kind_class = data["kind_class"]

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


def find_by_code_ci(db: Session, *, type_id: int, code: str) -> Optional[Entity]:
    """코드(안정 식별자)로 같은 축 안에서 조회(대소문자 무시). 커넥터가 외부 시스템의
    불변 코드/ID 로 객체를 매칭할 때 쓴다(표시 이름이 흔들려도 재동기화 시 중복 방지).
    code 는 유니크가 아니므로 여러 건이면 가장 낮은 id 를 결정적으로 반환."""
    needle = (code or "").strip().lower()
    if not needle:
        return None
    return (
        db.execute(
            select(Entity)
            .where(Entity.type_id == type_id, func.lower(Entity.code) == needle)
            .order_by(Entity.id)
        )
        .scalars()
        .first()
    )


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


def resolve_existing(
    db: Session, *, type_id: int, value: str, code: Optional[str] = None
) -> Optional[Entity]:
    """입력값 → 기존 엔티티 resolve. **code 가 주어지면 코드 매칭 우선**(안정 식별자),
    없으면 값 매칭(대소문자 무시) → 별칭 흡수. 셋 다 없으면 None(=신규 후보).
    code 기본값 None 이라 기존 호출부는 동작 불변(값·별칭 매칭)."""
    if code:
        hit = find_by_code_ci(db, type_id=type_id, code=code)
        if hit is not None:
            return hit
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


def _temporal_year_filter(year: int):
    """축의 temporal_kind 에 따라 "연도 Y 에 해당하는 값" WHERE 조건 (p56).

    각 행의 축 종류를 상관 스칼라 서브쿼리로 읽어 분기한다(명시 join 없이 —
    Entity.entity_type 의 eager join 과 충돌 회피):
      evergreen → 항상 통과 / lifecycle → 유효구간에 Y 포함 /
      yearly → entity_years 에 Y 존재 / derived → 그 해 보고서에 등장.
    """
    from app.modules.reports.models import Report  # 지연 import — 순환 회피

    type_kind = (
        select(EntityType.temporal_kind)
        .where(EntityType.id == Entity.type_id)
        .correlate(Entity)
        .scalar_subquery()
    )
    lifecycle_ok = and_(
        or_(Entity.valid_from_year.is_(None), Entity.valid_from_year <= year),
        or_(Entity.valid_to_year.is_(None), Entity.valid_to_year >= year),
    )
    yearly_ok = (
        select(EntityYear.entity_id)
        .where(EntityYear.entity_id == Entity.id, EntityYear.year == year)
        .correlate(Entity)
        .exists()
    )
    derived_ok = (
        select(ReportEntity.report_id)
        .join(Report, Report.id == ReportEntity.report_id)
        .where(
            ReportEntity.entity_id == Entity.id,
            func.extract("year", Report.report_date) == year,
        )
        .correlate(Entity)
        .exists()
    )
    return or_(
        type_kind == EntityTemporalKind.evergreen,
        and_(type_kind == EntityTemporalKind.lifecycle, lifecycle_ok),
        and_(type_kind == EntityTemporalKind.yearly, yearly_ok),
        and_(type_kind == EntityTemporalKind.derived, derived_ok),
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
    year: Optional[int] = None,
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
        if year is not None:
            stmt = stmt.where(_temporal_year_filter(year))
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
    if year is not None:
        stmt = stmt.where(_temporal_year_filter(year))
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


# --------------------------------------------------------------------------- #
# 속성 정의(property_defs) + 값 검증 (온톨로지 강화 A0)
# --------------------------------------------------------------------------- #
PROPERTY_DATA_TYPES = {
    "text", "longtext", "number", "date", "year", "bool", "enum", "entity_ref", "url",
}
_KEY_RE = re.compile(r"^[a-z][a-z0-9_]*$")


def _enum_values(enum_options) -> set:
    """enum_options([{value,label}] 또는 ["a","b"]) → 허용 값 집합."""
    out = set()
    for opt in enum_options or []:
        out.add(opt.get("value") if isinstance(opt, dict) else opt)
    return out


def list_property_defs(db: Session, *, owner_kind: str, owner_id: int) -> list[PropertyDef]:
    return list(
        db.execute(
            select(PropertyDef)
            .where(PropertyDef.owner_kind == owner_kind, PropertyDef.owner_id == owner_id)
            .order_by(PropertyDef.sort_order, PropertyDef.id)
        ).scalars()
    )


def get_property_def(db: Session, def_id: int) -> Optional[PropertyDef]:
    return db.get(PropertyDef, def_id)


def _check_data_type(dt: str, enum_options, ref_type_slug: str | None, db: Session) -> None:
    if dt not in PROPERTY_DATA_TYPES:
        raise ValueError(f"알 수 없는 data_type: {dt}")
    if dt == "enum" and not _enum_values(enum_options):
        raise ValueError("enum 속성은 enum_options 가 필요합니다.")
    if dt == "entity_ref" and ref_type_slug:
        ax = db.execute(
            select(EntityType).where(EntityType.slug == ref_type_slug)
        ).scalar_one_or_none()
        if ax is None:
            raise ValueError(f"ref_type_slug 축을 찾을 수 없습니다: {ref_type_slug}")


def create_property_def(
    db: Session, *, owner_kind: str, owner_id: int, payload: PropertyDefCreate
) -> PropertyDef:
    key = payload.key.strip()
    if not _KEY_RE.match(key):
        raise ValueError("key 는 소문자로 시작하는 [a-z0-9_] 여야 합니다.")
    dt = payload.data_type.strip()
    _check_data_type(dt, payload.enum_options, payload.ref_type_slug, db)
    dup = db.execute(
        select(PropertyDef).where(
            PropertyDef.owner_kind == owner_kind,
            PropertyDef.owner_id == owner_id,
            PropertyDef.key == key,
        )
    ).scalar_one_or_none()
    if dup is not None:
        raise ValueError(f"이미 있는 속성 키: {key}")
    row = PropertyDef(
        owner_kind=owner_kind,
        owner_id=owner_id,
        key=key,
        label=payload.label.strip(),
        data_type=dt,
        unit=(payload.unit or "").strip() or None,
        required=payload.required,
        multi=payload.multi,
        enum_options=payload.enum_options,
        ref_type_slug=(payload.ref_type_slug or "").strip() or None,
        sort_order=payload.sort_order,
        help=(payload.help or "").strip() or None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def update_property_def(
    db: Session, row: PropertyDef, payload: PropertyDefUpdate
) -> PropertyDef:
    data = payload.model_dump(exclude_unset=True)
    dt = data.get("data_type", row.data_type)
    enum_opts = data.get("enum_options", row.enum_options)
    ref_slug = data.get("ref_type_slug", row.ref_type_slug)
    if "data_type" in data or "enum_options" in data or "ref_type_slug" in data:
        _check_data_type((dt or "").strip(), enum_opts, ref_slug, db)
    for field in (
        "label", "data_type", "unit", "required", "multi",
        "enum_options", "ref_type_slug", "sort_order", "help",
    ):
        if field in data:
            val = data[field]
            if field in ("label", "data_type"):
                val = (val or "").strip()
            elif field in ("unit", "ref_type_slug", "help"):
                val = (val or "").strip() or None
            setattr(row, field, val)
    db.commit()
    db.refresh(row)
    return row


def delete_property_def(db: Session, row: PropertyDef) -> None:
    db.delete(row)
    db.commit()


def _validate_one(defn: PropertyDef, value, db: Session):
    """단일 값 1개를 data_type 에 맞춰 검증·정규화. 실패 시 ValueError."""
    dt = defn.data_type
    label = defn.label
    if dt in ("text", "longtext", "url"):
        if not isinstance(value, str):
            raise ValueError(f"{label} 은(는) 문자열이어야 합니다.")
        v = value.strip()
        if dt == "url" and v and not re.match(r"^https?://", v):
            raise ValueError(f"{label} 은(는) http(s):// URL 이어야 합니다.")
        return v
    if dt == "number":
        if isinstance(value, bool):
            raise ValueError(f"{label} 은(는) 숫자여야 합니다.")
        if isinstance(value, (int, float)):
            return value
        try:
            return float(value)
        except (TypeError, ValueError):
            raise ValueError(f"{label} 은(는) 숫자여야 합니다.")
    if dt == "year":
        try:
            iv = int(value)
        except (TypeError, ValueError):
            raise ValueError(f"{label} 은(는) 연도(정수)여야 합니다.")
        if not (1900 <= iv <= 2200):
            raise ValueError(f"{label} 연도 범위가 올바르지 않습니다.")
        return iv
    if dt == "bool":
        if isinstance(value, bool):
            return value
        raise ValueError(f"{label} 은(는) true/false 여야 합니다.")
    if dt == "enum":
        if value not in _enum_values(defn.enum_options):
            raise ValueError(f"{label} 은(는) 허용된 선택지가 아닙니다: {value}")
        return value
    if dt == "date":
        from datetime import date

        try:
            date.fromisoformat(str(value))
        except ValueError:
            raise ValueError(f"{label} 은(는) YYYY-MM-DD 형식이어야 합니다.")
        return str(value)
    if dt == "entity_ref":
        try:
            rid = int(value)
        except (TypeError, ValueError):
            raise ValueError(f"{label} 은(는) 엔티티 id 여야 합니다.")
        ref = db.get(Entity, rid)
        if ref is None:
            raise ValueError(f"{label} 이(가) 가리키는 엔티티가 없습니다: {rid}")
        if defn.ref_type_slug and ref.entity_type and ref.entity_type.slug != defn.ref_type_slug:
            raise ValueError(f"{label} 은(는) '{defn.ref_type_slug}' 축이어야 합니다.")
        return rid
    raise ValueError(f"알 수 없는 data_type: {dt}")


def _validate_props(db: Session, defs_list, properties) -> dict:
    """properties dict 를 주어진 property_defs 목록으로 검증·정규화. 미정의 키·
    형식 오류·필수 누락 시 ValueError. entity_type / relation_type 공통 코어."""
    props = properties or {}
    if not isinstance(props, dict):
        raise ValueError("properties 는 객체(dict)여야 합니다.")
    defs = {d.key: d for d in defs_list}
    unknown = set(props) - set(defs)
    if unknown:
        raise ValueError(f"정의되지 않은 속성: {', '.join(sorted(unknown))}")
    out: dict = {}
    for key, defn in defs.items():
        raw = props.get(key)
        empty = raw is None or raw == "" or raw == []
        if empty:
            if defn.required:
                raise ValueError(f"필수 속성 누락: {defn.label}({key})")
            continue
        if defn.multi:
            if not isinstance(raw, list):
                raise ValueError(f"{defn.label} 은(는) 배열이어야 합니다.")
            out[key] = [_validate_one(defn, x, db) for x in raw]
        else:
            if isinstance(raw, list):
                raise ValueError(f"{defn.label} 은(는) 단일 값이어야 합니다.")
            out[key] = _validate_one(defn, raw, db)
    return out


def validate_properties(db: Session, type_row: EntityType, properties) -> dict:
    """엔티티(entity_type) 속성 검증. 반환값을 entities.properties 에 저장한다."""
    return _validate_props(
        db,
        list_property_defs(db, owner_kind="entity_type", owner_id=type_row.id),
        properties,
    )


def validate_relation_properties(
    db: Session, rtype: "RelationType", properties
) -> dict:
    """링크(relation_type) 속성 검증 (A0.2). 반환값을 entity_relations.properties
    에 저장한다. 관계 종류에 정의된 property_defs(owner_kind='relation_type')로 검증."""
    return _validate_props(
        db,
        list_property_defs(db, owner_kind="relation_type", owner_id=rtype.id),
        properties,
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

    #   4) 속성(A0)이 오면 축 스키마로 검증. 미정의 키·형식·필수 누락 시 ValueError.
    props = validate_properties(db, type_row, payload.properties) if payload.properties else {}

    code = (payload.code or "").strip() or None
    row = Entity(
        type_id=payload.type_id,
        value=value,
        code=code,
        description=(payload.description or "").strip(),
        status=EntityStatus.active,
        created_by_user_id=creator_user_id,
        properties=props,
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    # yearly 축(모델 등)은 새 값이 "올해 배정"으로 시작하게 한다 — 연도 필터
    # 기본값(올해)에서 방금 만든 값이 곧바로 보이도록. 이후 다른 연도는 admin 이
    # 추가. lifecycle/derived/evergreen 축은 자동 배정하지 않는다.
    if type_row.temporal_kind == EntityTemporalKind.yearly:
        db.add(EntityYear(entity_id=row.id, year=datetime.utcnow().year))
        db.commit()

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
    # 유효구간 (p56, lifecycle). 키가 오면 그대로 반영 — null 이면 해제(개방).
    if "valid_from_year" in data:
        row.valid_from_year = data["valid_from_year"]
    if "valid_to_year" in data:
        row.valid_to_year = data["valid_to_year"]
    # 속성(A0). 키를 보내면 축 스키마로 검증 후 통째로 교체(null 이면 {} 로 초기화).
    if "properties" in data:
        row.properties = validate_properties(db, row.entity_type, data["properties"] or {})

    db.commit()
    db.refresh(row)
    return row


def get_entity_years(db: Session, entity_id: int) -> list[int]:
    """yearly 축 값에 배정된 연도(오름차순). 다른 축에선 보통 빈 리스트."""
    return list(
        db.execute(
            select(EntityYear.year)
            .where(EntityYear.entity_id == entity_id)
            .order_by(EntityYear.year)
        ).scalars()
    )


def set_entity_years(db: Session, row: Entity, years: list[int]) -> list[int]:
    """연도 세트 전체 교체(replace). 중복·None 제거 후 정렬해 저장."""
    clean = sorted({int(y) for y in years if y is not None})
    db.execute(delete(EntityYear).where(EntityYear.entity_id == row.id))
    for y in clean:
        db.add(EntityYear(entity_id=row.id, year=y))
    db.commit()
    return clean


def merge_entities(
    db: Session,
    *,
    src: Entity,
    into: Entity,
    merged_by_user_id: int | None = None,
    allow_cross_axis: bool = False,
) -> int:
    """Re-link all `report_entities` rows from `src` to `into`, drop `src`,
    return the number of reports re-linked.

    Caller (route) must have admin role. Both entities must live on the
    same axis — merging across axes would change a report's meaning, not
    just dedupe a value. If `into` is already linked to a report that
    `src` is also linked to, the duplicate link is silently dropped
    (composite PK on report_entities).

    `allow_cross_axis=True` 는 축을 넘는 흡수를 허용한다 — "잘못된 축의 값을
    올바른 축으로 이관"(reassign_entity_axis)에서 대상 축에 이미 같은 값이 있을
    때만 쓰인다. src 의 별칭/관계는 into(대상 축)로 이관되고 src 는 삭제된다.

    `merged_by_user_id` 가 주어지면 `entity_merges` 감사 로그를 남긴다(p60) — src
    는 삭제되므로 값/코드/흡수 별칭을 스냅샷으로 보존(되돌리기 정책="감사 로그만").
    """
    if src.id == into.id:
        return 0
    if not allow_cross_axis and src.type_id != into.type_id:
        raise ValueError("같은 타입(축)의 엔티티끼리만 머지할 수 있습니다.")

    # 삭제 전 스냅샷 — 감사 로그용(src 는 아래에서 사라진다).
    snap_type_id = src.type_id
    snap_src_id = src.id
    snap_src_value = src.value
    snap_src_code = src.code
    snap_into_id = into.id
    snap_into_value = into.value
    absorbed_aliases: list[str] = []

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
            absorbed_aliases.append(a.alias)
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
        absorbed_aliases.append(src.value)

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

    # 감사 로그 (p60) — src 삭제 전에 스냅샷으로 기록. by 가 없으면 생략(내부 호출).
    if merged_by_user_id is not None:
        db.add(
            EntityMerge(
                type_id=snap_type_id,
                src_entity_id=snap_src_id,
                src_value=snap_src_value,
                src_code=snap_src_code,
                into_entity_id=snap_into_id,
                into_value=snap_into_value,
                absorbed_aliases=absorbed_aliases,
                relinked_report_count=relinked,
                merged_by_user_id=merged_by_user_id,
            )
        )

    db.delete(src)
    db.commit()
    return relinked


def reassign_entity_axis(
    db: Session,
    *,
    entity: Entity,
    target_type: EntityType,
    moved_by_user_id: int | None = None,
) -> tuple[str, int | None]:
    """엔티티를 다른 축(target_type)으로 이관한다. 태깅(report_entities)은
    entity_id 기준이라 **자동으로 따라온다** — 링크를 건드리지 않는다.

    두 경로로 갈린다:
      - 대상 축에 같은 값(또는 별칭)이 이미 있으면 그 값으로 **머지**(cross-axis,
        원본 삭제) → ("merged", into_id)
      - 없으면 **type_id 재지정**으로 통째로 이사(별칭도 함께 이동, 대상 축에
        같은 표기가 이미 있으면 그 별칭은 드롭). 속성(properties)은 보존 →
        ("moved", None)

    대상 축의 value_pattern 에 맞지 않으면 ValueError(호출자가 건너뛴다). 이미
    대상 축이면 ("noop", None).
    """
    if entity.type_id == target_type.id:
        return ("noop", None)

    # 1) 대상 축 값 형식 검증 — 안 맞으면 이관 거부(호출자가 사유와 함께 건너뜀).
    if not value_matches_pattern(target_type.value_pattern, entity.value):
        raise ValueError(
            f"'{entity.value}' 은(는) 대상 축 '{target_type.label}' 형식에 맞지 "
            "않습니다"
            + (
                f" (패턴: {target_type.value_pattern})"
                if target_type.value_pattern
                else ""
            )
            + "."
        )

    # 2) 대상 축에 같은 값/별칭이 있으면 그 값으로 흡수(원본 삭제).
    existing = resolve_existing(db, type_id=target_type.id, value=entity.value)
    if existing is not None and existing.id != entity.id:
        merge_entities(
            db,
            src=entity,
            into=existing,
            merged_by_user_id=moved_by_user_id,
            allow_cross_axis=True,
        )
        return ("merged", existing.id)

    # 3) 충돌 없음 → 축만 바꿔 통째로 이사. 별칭 type_id 도 함께 옮기되, 대상 축에
    #    같은 정규화 표기가 이미 있으면 (type_id, normalized) 유니크 충돌을 피해
    #    그 별칭은 버린다. 속성(JSONB)은 손대지 않아 데이터 손실이 없다(대상 축
    #    스키마와 안 맞는 키는 UI 가 무시할 뿐 보존됨).
    entity.type_id = target_type.id
    for al in list(
        db.execute(
            select(EntityAlias).where(EntityAlias.entity_id == entity.id)
        ).scalars()
    ):
        clash = db.execute(
            select(EntityAlias).where(
                EntityAlias.type_id == target_type.id,
                EntityAlias.normalized == al.normalized,
            )
        ).scalar_one_or_none()
        if clash is not None and clash.id != al.id:
            db.delete(al)
        else:
            al.type_id = target_type.id
        db.flush()
    db.commit()
    return ("moved", None)


def dismiss_merge_pair(
    db: Session, *, entity_a: Entity, entity_b: Entity, user_id: int | None
) -> bool:
    """중복 후보에서 "중복 아님"으로 기각한 쌍을 negative list 에 적재 (p60).
    (low, high) 정규화로 (A,B)=(B,A) 중복 방지. 이미 있으면 멱등(False 반환,
    새로 적재하면 True). 같은 축이 아니면 ValueError."""
    if entity_a.id == entity_b.id:
        raise ValueError("같은 엔티티는 기각할 수 없습니다.")
    if entity_a.type_id != entity_b.type_id:
        raise ValueError("같은 타입(축)의 엔티티 쌍만 기각할 수 있습니다.")
    low, high = sorted((entity_a.id, entity_b.id))
    existing = db.execute(
        select(EntityMergeDismissal).where(
            EntityMergeDismissal.entity_low_id == low,
            EntityMergeDismissal.entity_high_id == high,
        )
    ).scalar_one_or_none()
    if existing is not None:
        return False
    db.add(
        EntityMergeDismissal(
            type_id=entity_a.type_id,
            entity_low_id=low,
            entity_high_id=high,
            dismissed_by_user_id=user_id,
        )
    )
    db.commit()
    return True


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


def _validate_evidence_report(db: Session, report_id: Optional[int]) -> None:
    """근거 보고서 id 가 실재하는지 확인 (A0.2). None 이면 통과."""
    if report_id is None:
        return
    from app.modules.reports.models import Report

    if db.get(Report, report_id) is None:
        raise ValueError(f"근거 보고서를 찾을 수 없습니다: {report_id}")


def add_relation(
    db: Session,
    *,
    src: Entity,
    dst: Entity,
    relation: str = RELATION_PART_OF,
    creator_user_id: Optional[int] = None,
    properties: Optional[dict] = None,
    evidence_report_id: Optional[int] = None,
    evidence_note: Optional[str] = None,
) -> EntityRelation:
    """src --relation--> dst 추가. 관계 종류는 relation_types 레지스트리(p55)에서
    조회·검증한다 — 허용 타입인지, 축 제약(src_axis_slugs/dst_axis_slugs)에 맞는지,
    acyclic 타입이면 순환이 안 되는지. 자기참조·중복도 막는다.

    A0.2: 링크 속성(relation_type 스키마로 검증)·근거 보고서(provenance)를 함께
    저장한다. 이미 있으면 멱등 — 단, 속성/근거가 넘어오면 그 값으로 갱신 후 반환."""
    rtype = get_relation_type(db, relation)
    if rtype is None:
        raise ValueError(f"지원하지 않는 관계 종류입니다: {relation}")
    if src.id == dst.id:
        raise ValueError("자기 자신과는 관계를 맺을 수 없습니다.")

    validated_props = validate_relation_properties(db, rtype, properties)
    _validate_evidence_report(db, evidence_report_id)

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
        # 멱등이되, 넘어온 속성/근거는 반영(재-add 로 근거 붙이기 지원).
        if properties is not None:
            existing.properties = validated_props
        if evidence_report_id is not None:
            existing.evidence_report_id = evidence_report_id
        if evidence_note is not None:
            existing.evidence_note = evidence_note
        db.commit()
        db.refresh(existing)
        return existing

    # 순환 가드는 acyclic 타입만(part_of·supersedes 등). 비acyclic 타입(tested_by 등)은
    # 애초에 계층이 아니라 순환 개념이 없어 가드를 건너뛴다.
    if rtype.acyclic and src.id in _ancestors_up(db, start_id=dst.id, relation=relation):
        raise ValueError("순환 관계가 되어 추가할 수 없습니다.")

    row = EntityRelation(
        src_entity_id=src.id,
        dst_entity_id=dst.id,
        relation=relation,
        properties=validated_props,
        evidence_report_id=evidence_report_id,
        evidence_note=evidence_note,
        created_by_user_id=creator_user_id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def get_relation(db: Session, relation_id: int) -> Optional[EntityRelation]:
    return db.get(EntityRelation, relation_id)


_UNSET = object()


def update_relation(
    db: Session,
    row: EntityRelation,
    *,
    properties=_UNSET,
    evidence_report_id=_UNSET,
    evidence_note=_UNSET,
) -> EntityRelation:
    """링크의 속성/근거 수정 (A0.2). 넘긴 필드만 반영(_UNSET=미변경). properties 는
    관계 종류 스키마로 검증 후 통째로 교체. evidence_report_id 존재 확인."""
    if properties is not _UNSET:
        rtype = get_relation_type(db, row.relation)
        if rtype is None:
            raise ValueError(f"지원하지 않는 관계 종류입니다: {row.relation}")
        row.properties = validate_relation_properties(db, rtype, properties)
    if evidence_report_id is not _UNSET:
        _validate_evidence_report(db, evidence_report_id)
        row.evidence_report_id = evidence_report_id
    if evidence_note is not _UNSET:
        row.evidence_note = evidence_note
    db.commit()
    db.refresh(row)
    return row


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


def expand_related(db: Session, *, entity_ids) -> list[int]:
    """'관련 포함' 확장 (2b) — 선택 엔티티에서 관계 그래프를 타고 관련 엔티티까지
    넓힌다. `expand_with_descendants`(part_of 자손 전용)의 일반화.

    스마트 기본(relation_types 메타 활용, 깊이 UI 불필요), 2단계:
      1) 이행관계(transitive=True, 예: part_of)로 **자손(direction='in')까지 끝까지**
         롤업 — 기존 '하위 포함'과 같은 안전한 방향(형제·조상으로 새지 않음).
      2) 그 구조 집합에서 비이행관계로 **1-hop** — 관계별 방향성(p55 directed)을
         존중한다: 방향성 관계(tested_by·has_defect 등 src=주체→dst=속성)는 'out'
         (주체에서 속성으로만), 무방향 관계는 'both'. 시험·불량은 보통 모델이 아니라
         부품에 직접 연결되므로 1단계 자손 확장이 선행돼야 잡힌다.
    관계가 없으면 원본 그대로(no-op)."""
    base = {int(x) for x in entity_ids}
    if not base:
        return []
    rel_rows = db.execute(
        select(RelationType.slug, RelationType.transitive, RelationType.directed)
    ).all()
    transitive = [slug for slug, t, _ in rel_rows if t]
    # 비이행을 방향성 유무로 나눠 각자 의미 있는 방향으로만 따라간다.
    nt_directed = [slug for slug, t, d in rel_rows if not t and d]
    nt_undirected = [slug for slug, t, d in rel_rows if not t and not d]
    # 1) 이행관계 자손 롤업.
    structural = set(base)
    if transitive:
        structural |= graph.reachable(
            db, base, relations=transitive, direction="in"
        )
    # 2) 구조 집합 주변의 비이행 1-hop — 방향성은 'out'(주체→속성), 무방향은 'both'.
    out = set(structural)
    if nt_directed:
        out |= graph.reachable(
            db, structural, relations=nt_directed, direction="out", max_depth=1
        )
    if nt_undirected:
        out |= graph.reachable(
            db, structural, relations=nt_undirected, direction="both", max_depth=1
        )
    return list(out)


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


def move_taggings(
    db: Session,
    *,
    src: Entity,
    into: Entity,
    report_ids: list[int] | None = None,
) -> int:
    """이 값(src)이 걸린 보고서 태깅을 into 로 옮긴다 — **src 자신은 남긴다**.

    "모두 해제"(unlink_from_all_reports)의 '이동' 버전: 태그를 떼는 대신 다른
    값으로 재태깅한다. merge_entities 와 달리 src 를 삭제하지 않고, 별칭 흡수·
    관계 이관·감사 로그도 하지 않는다(순수 재연결). 실행 후 src 의 사용이 0이 되면
    삭제할 수 있다.

    `report_ids` 가 주어지면 **그 보고서들만** 옮긴다(일부 이동) — 나머지는 src 에
    그대로 남는다. None 이면 전량 이동. 같은 축이어야 한다(축을 넘으면 보고서의
    의미가 바뀌므로). 대상 보고서에 이미 into 가 붙어 있으면 중복 링크
    (report_entities 복합 PK)는 버린다. 반환: 옮긴 보고서 수.
    """
    if src.id == into.id:
        return 0
    if src.type_id != into.type_id:
        raise ValueError("같은 축의 값으로만 이동할 수 있습니다.")
    if report_ids is not None and not report_ids:
        return 0

    # 벌크 2문장 — 행당 루프 대신(수천 건도 즉시·타임아웃 무관). synchronize_session
    # =False: 세션 ORM 캐시 동기화를 생략(직후 commit, 로드된 ReportEntity 인스턴스를
    # 다시 쓰지 않음).
    #   1) 대상(into)에 이미 링크가 있는 보고서의 src 링크는 제거(복합 PK 충돌 방지).
    #   2) 남은 src 링크의 entity_id 를 into 로 재지정(UPDATE=원자적, 무태그 순간 없음).
    into_reports = select(ReportEntity.report_id).where(
        ReportEntity.entity_id == into.id
    )
    del_stmt = delete(ReportEntity).where(
        ReportEntity.entity_id == src.id,
        ReportEntity.report_id.in_(into_reports),
    )
    upd_stmt = update(ReportEntity).where(ReportEntity.entity_id == src.id)
    if report_ids is not None:
        del_stmt = del_stmt.where(ReportEntity.report_id.in_(report_ids))
        upd_stmt = upd_stmt.where(ReportEntity.report_id.in_(report_ids))
    db.execute(del_stmt.execution_options(synchronize_session=False))
    result = db.execute(
        upd_stmt.values(entity_id=into.id).execution_options(
            synchronize_session=False
        )
    )
    moved = result.rowcount or 0
    db.commit()
    return moved


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


def list_report_links_for_entity(db: Session, *, entity_id: int) -> list:
    """객체 프로필(Phase A)용 — 이 값을 태깅한 보고서 (id, title, workspace_slug,
    updated_at) 최신순. 관리자 삭제 다이얼로그용 `list_reports_using_entity` 와 달리
    **소프트삭제(휴지통) 보고서는 제외**한다. 가시성 교집합은 라우트가
    `reports.services.all_visible_report_ids` 로 적용 — 여기선 전역 조인만."""
    from app.modules.reports.models import Report  # local to avoid cycle

    stmt = (
        select(Report.id, Report.title, Report.workspace_slug, Report.updated_at)
        .join(ReportEntity, ReportEntity.report_id == Report.id)
        .where(
            ReportEntity.entity_id == entity_id,
            Report.deleted_at.is_(None),
        )
        .order_by(Report.updated_at.desc())
    )
    return list(db.execute(stmt).all())


# --------------------------------------------------------------------------- #
# Cross-kind 링크 (A0.3 스텝2) — ObjectRef 해석 + object_links
# --------------------------------------------------------------------------- #
# ObjectRef = (type, id:str). type 은 entity 축 slug(reference/record) 또는 system
# 축 slug('dept' 등). system 은 entities 행이 없고 원 테이블을 투영한다.

def resolve_object(
    db: Session, obj_type: str, obj_id: str, actor=None
) -> Optional[dict]:
    """ObjectRef 를 균일한 표시형으로 해석. 모르는 타입/대상은 None.
    반환: {type, id, kind_class, label, url, icon, deleted}.

    actor(요청 User) 는 **report 가시성 게이트**용 — report 는 요청자가 볼 수 있는
    것만 해석하고 권한 밖·actor 없음이면 None(존재 자체 비노출). dept/user/entity 는
    actor 무시. (설계: system객체확장_user·report투영)."""
    type_row = get_type_by_slug(db, obj_type)
    if type_row is None:
        return None

    if type_row.kind_class == EntityKindClass.system:
        if obj_type == "dept":
            from app.modules.workspaces.models import Workspace

            ws = db.get(Workspace, obj_id)
            if ws is None:
                return None
            return {
                "type": "dept", "id": obj_id, "kind_class": "system",
                "label": ws.name, "url": f"/w/{obj_id}", "icon": type_row.icon,
                "deleted": False,
            }
        if obj_type == "user":
            from app.modules.users.models import User

            try:
                uid = int(obj_id)
            except (TypeError, ValueError):
                return None
            u = db.get(User, uid)
            if u is None:
                return None
            # 라벨=이름만(email·역할 비노출). 비활성=deleted 표기(감사용 유지).
            return {
                "type": "user", "id": obj_id, "kind_class": "system",
                "label": u.name, "url": f"/objects/user/{obj_id}",
                "icon": type_row.icon, "deleted": not u.is_active,
            }
        if obj_type == "report":
            from app.modules.reports.models import Report
            from app.modules.reports.services import all_visible_report_ids

            try:
                rid = int(obj_id)
            except (TypeError, ValueError):
                return None
            # ★ 가시성 게이트 — 요청자가 볼 수 있는 보고서만(권한 밖·actor 없음 → None).
            if actor is None or rid not in all_visible_report_ids(db, actor.id):
                return None
            r = db.get(Report, rid)
            if r is None:
                return None
            return {
                "type": "report", "id": obj_id, "kind_class": "system",
                "label": r.title, "url": f"/reports/{obj_id}",
                "icon": type_row.icon, "deleted": r.deleted_at is not None,
            }
        return None

    # entity(reference/record) — id 는 정수.
    try:
        eid = int(obj_id)
    except (TypeError, ValueError):
        return None
    ent = get_entity(db, eid)
    if ent is None or (ent.entity_type and ent.entity_type.slug != obj_type):
        return None
    return {
        "type": obj_type, "id": obj_id, "kind_class": type_row.kind_class.value,
        "label": ent.value, "url": f"/entities/{eid}", "icon": type_row.icon,
        "deleted": ent.status == EntityStatus.deprecated,
    }


_DERIVED_LIMIT = 50


def derived_links_for(db: Session, actor, obj_type: str, obj_id: str) -> list[dict]:
    """FK 파생 관계(저장 0) — report/user 의 온플라이 관계. report 는 가시성 게이트.
    반환: [{relation, relation_label, direction('out'|'in'), object}]. 상한 _DERIVED_LIMIT.
    설계: system객체확장_user·report투영 §4."""
    rel_labels = {rt.slug: rt.label for rt in list_relation_types(db)}
    out: list[dict] = []

    def add(relation, direction, ref):
        if ref:
            out.append({
                "relation": relation,
                "relation_label": rel_labels.get(relation, relation),
                "direction": direction, "object": ref,
            })

    if obj_type == "report":
        from app.modules.reports.models import Report
        from app.modules.reports.services import all_visible_report_ids

        try:
            rid = int(obj_id)
        except (TypeError, ValueError):
            return []
        if actor is None or rid not in all_visible_report_ids(db, actor.id):
            return []
        r = db.get(Report, rid)
        if r is None:
            return []
        if r.owner_user_id:
            add("authored_by", "out", resolve_object(db, "user", str(r.owner_user_id), actor))
        led = getattr(r, "last_edited_by_user_id", None)
        if led and led != r.owner_user_id:
            add("edited_by", "out", resolve_object(db, "user", str(led), actor))
        if r.workspace_slug:
            add("published_in", "out", resolve_object(db, "dept", r.workspace_slug, actor))
        for ent in (r.entities or [])[:_DERIVED_LIMIT]:
            if ent.entity_type:
                add("documents", "out",
                    resolve_object(db, ent.entity_type.slug, str(ent.id), actor))

    elif obj_type == "user":
        from app.modules.reports.models import Report
        from app.modules.reports.services import all_visible_report_ids
        from app.modules.users.models import User, WorkspaceMember

        try:
            uid = int(obj_id)
        except (TypeError, ValueError):
            return []
        u = db.get(User, uid)
        if u is None:
            return []
        # member_of → 소속 부서(home + 멤버십).
        seen: set[str] = set()
        slugs: list[str] = []
        if u.home_workspace_slug:
            slugs.append(u.home_workspace_slug)
            seen.add(u.home_workspace_slug)
        for slug in db.scalars(
            select(WorkspaceMember.workspace_slug).where(WorkspaceMember.user_id == uid)
        ).all():
            if slug not in seen:
                slugs.append(slug)
                seen.add(slug)
        for slug in slugs[:_DERIVED_LIMIT]:
            add("member_of", "out", resolve_object(db, "dept", slug, actor))
        # 역방향 — 이 사용자가 작성한 '볼 수 있는' 보고서.
        if actor is not None:
            visible = all_visible_report_ids(db, actor.id)
            rep_ids = db.scalars(
                select(Report.id)
                .where(Report.owner_user_id == uid, Report.deleted_at.is_(None))
                .order_by(Report.updated_at.desc())
                .limit(300)
            ).all()
            n = 0
            for rid in rep_ids:
                if rid in visible:
                    add("authored_by", "in", resolve_object(db, "report", str(rid), actor))
                    n += 1
                    if n >= _DERIVED_LIMIT:
                        break

    return out


def add_object_link(
    db: Session,
    *,
    src: Entity,
    dst_type: str,
    dst_id: str,
    relation: str,
    creator_user_id: Optional[int] = None,
    properties: Optional[dict] = None,
    evidence_report_id: Optional[int] = None,
    evidence_note: Optional[str] = None,
) -> ObjectLink:
    """엔티티 src → system 객체(dst_type/dst_id) 링크 추가 (A0.3 스텝2).
    relation_types 카탈로그로 검증 — 허용 타입인지, 축 제약(src=src 엔티티 축,
    dst=dst_type)에 맞는지. 대상이 실재하는지 ObjectRef 로 확인. 속성/근거는
    A0.2 로직 재사용. 이미 있으면 멱등(속성/근거 넘어오면 갱신)."""
    rtype = get_relation_type(db, relation)
    if rtype is None:
        raise ValueError(f"지원하지 않는 관계 종류입니다: {relation}")

    src_slug = src.entity_type.slug if src.entity_type else None
    if rtype.src_axis_slugs and src_slug not in rtype.src_axis_slugs:
        raise ValueError(
            f"'{rtype.label}' 관계의 출발 축이 아닙니다(허용: {', '.join(rtype.src_axis_slugs)})."
        )
    if rtype.dst_axis_slugs and dst_type not in rtype.dst_axis_slugs:
        raise ValueError(
            f"'{rtype.label}' 관계의 도착 축이 아닙니다(허용: {', '.join(rtype.dst_axis_slugs)})."
        )
    if resolve_object(db, dst_type, dst_id) is None:
        raise ValueError(f"대상 객체를 찾을 수 없습니다: {dst_type}/{dst_id}")

    validated = validate_relation_properties(db, rtype, properties)
    _validate_evidence_report(db, evidence_report_id)

    src_type = src_slug or ""
    src_id = str(src.id)
    existing = db.execute(
        select(ObjectLink).where(
            ObjectLink.src_type == src_type,
            ObjectLink.src_id == src_id,
            ObjectLink.dst_type == dst_type,
            ObjectLink.dst_id == dst_id,
            ObjectLink.relation == relation,
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.properties = validated
        if evidence_report_id is not None or evidence_note is not None:
            existing.evidence_report_id = evidence_report_id
            existing.evidence_note = evidence_note
        db.commit()
        db.refresh(existing)
        return existing

    row = ObjectLink(
        src_type=src_type, src_id=src_id, dst_type=dst_type, dst_id=dst_id,
        relation=relation, properties=validated,
        evidence_report_id=evidence_report_id, evidence_note=evidence_note,
        created_by_user_id=creator_user_id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def list_object_links_for_ref(
    db: Session, obj_type: str, obj_id: str
) -> tuple[list[ObjectLink], list[ObjectLink]]:
    """(outgoing, incoming) — 이 ObjectRef(type, id) 가 한쪽 끝인 object_links.
    outgoing = 이것이 src(예: 과제→부서), incoming = 이것이 dst(예: 부서←과제들).
    entity·system 양쪽 다 동작(부서 역방향 조회 = incoming)."""
    outgoing = list(
        db.execute(
            select(ObjectLink).where(
                ObjectLink.src_type == obj_type, ObjectLink.src_id == obj_id
            )
        ).scalars()
    )
    incoming = list(
        db.execute(
            select(ObjectLink).where(
                ObjectLink.dst_type == obj_type, ObjectLink.dst_id == obj_id
            )
        ).scalars()
    )
    return outgoing, incoming


def list_object_links_for_entity(
    db: Session, *, entity_id: int, axis_slug: str
) -> tuple[list[ObjectLink], list[ObjectLink]]:
    """엔티티 편의 래퍼 — (axis_slug, str(entity_id)) 로 ref 조회에 위임."""
    return list_object_links_for_ref(db, axis_slug, str(entity_id))


def get_object_link(db: Session, link_id: int) -> Optional[ObjectLink]:
    return db.get(ObjectLink, link_id)


def delete_object_link(db: Session, row: ObjectLink) -> None:
    db.delete(row)
    db.commit()


# --------------------------------------------------------------------------- #
# Record 위젯 입력경로 (A0.3) — 보고서의 객체 레코드 위젯 → entity upsert
# --------------------------------------------------------------------------- #
def upsert_record_entity(
    db: Session,
    *,
    axis_slug: str,
    name: Optional[str],
    properties: Optional[dict] = None,
    entity_id: Optional[int] = None,
    code: Optional[str] = None,
    creator_user_id: int,
) -> Optional[Entity]:
    """객체 레코드 위젯·커넥터 저장 훅용 upsert. record 축의 값(name)+속성으로 entity 를
    생성/갱신한다. 우선순위: (1) entity_id → (2) **code 매칭(안정 식별자, 있으면 우선)**
    → (3) 같은 축·같은 이름 → (4) 신규 생성. record 축이 아니거나 이름이 비면 None.
    속성 검증 실패는 ValueError. code 는 신규 생성 시 저장, 기존이 비어 있으면 보강."""
    type_row = get_type_by_slug(db, (axis_slug or "").strip())
    if type_row is None or type_row.kind_class != EntityKindClass.record:
        return None
    value = (name or "").strip()
    if not value:
        return None
    code = (code or "").strip() or None

    ent: Optional[Entity] = None
    if entity_id is not None:
        cand = get_entity(db, entity_id)
        if cand is not None and cand.type_id == type_row.id:
            ent = cand
    if ent is None:
        ent = resolve_existing(db, type_id=type_row.id, value=value, code=code)

    if ent is None:
        # 신규 — create_entity 가 속성 검증까지 처리.
        return create_entity(
            db,
            EntityCreate(type_id=type_row.id, value=value, code=code,
                         properties=properties or {}),
            creator_user_id=creator_user_id,
        )

    # 기존 갱신 — 속성 교체 + (안전하면) 이름 동기화 + code 보강.
    ent.properties = validate_properties(db, type_row, properties or {})
    if value and value != ent.value:
        clash = find_by_value_ci(db, type_id=type_row.id, value=value)
        if clash is None or clash.id == ent.id:
            ent.value = value
    if code and not ent.code:
        ent.code = code
    db.commit()
    db.refresh(ent)
    return ent


# --------------------------------------------------------------------------- #
# 객체 중심 검색 (Phase C) — 타입 + 속성(JSONB) + 관계로 엔티티 필터
# --------------------------------------------------------------------------- #
def _prop_where(defn: PropertyDef, op: str, value):
    """속성 하나에 대한 WHERE 조건. data_type 에 맞춰 JSONB 텍스트를 캐스팅/비교.
    지원 안 되는 조합이면 None(무시)."""
    key = defn.key
    txt = Entity.properties[key].astext  # JSONB -> text
    dt = defn.data_type

    if defn.multi and op == "has":
        # 배열 속성 — JSONB @> [value] (값 포함).
        return Entity.properties[key].contains([value])

    if dt == "number":
        num = cast(txt, Float)
        try:
            if op == "gte":
                return num >= float(value)
            if op == "lte":
                return num <= float(value)
            if op == "between" and isinstance(value, (list, tuple)) and len(value) == 2:
                return num.between(float(value[0]), float(value[1]))
            return num == float(value)
        except (TypeError, ValueError):
            return None
    if dt in ("date", "year"):
        # YYYY-MM-DD / 정수연도 문자열은 사전식 비교가 곧 시간순.
        v = str(value)
        if op == "gte":
            return txt >= v
        if op == "lte":
            return txt <= v
        if op == "between" and isinstance(value, (list, tuple)) and len(value) == 2:
            return txt.between(str(value[0]), str(value[1]))
        return txt == v
    if dt == "bool":
        return txt == ("true" if value in (True, "true", "True", 1, "1") else "false")
    # text / enum / url / entity_ref
    if op == "in" and isinstance(value, (list, tuple)):
        return txt.in_([str(v) for v in value])
    if op == "contains":
        return func.lower(txt).like(f"%{str(value).strip().lower()}%")
    return txt == str(value)


def search_entities(
    db: Session,
    *,
    type_id: Optional[int] = None,
    q: Optional[str] = None,
    props: Optional[list] = None,
    relations: Optional[list] = None,
    year: Optional[int] = None,
    include_deprecated: bool = False,
    sort: str = "value",
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[Entity], int]:
    """객체 중심 검색 (Phase C). 타입 + 이름/코드/설명(q) + 속성(JSONB) + 관계 +
    연도 로 엔티티를 필터. 속성/관계 필터는 type_id 기준. (엔티티 tags 로 보고서를
    찾는 search_reports 와 반대 — 여기선 객체 자체를 찾는다.) 반환: (items, total)."""
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

    # 속성 필터 — 축 property_defs 로 data_type 을 알아 캐스팅.
    if props and type_id is not None:
        defs = {
            d.key: d
            for d in list_property_defs(db, owner_kind="entity_type", owner_id=type_id)
        }
        for f in props:
            key = f.get("key") if isinstance(f, dict) else f.key
            op = (f.get("op") if isinstance(f, dict) else f.op) or "eq"
            value = f.get("value") if isinstance(f, dict) else f.value
            defn = defs.get(key)
            if defn is None or value in (None, "", []):
                continue
            cond = _prop_where(defn, op, value)
            if cond is not None:
                stmt = stmt.where(cond)

    # 관계 필터 — dst 에 (relation 종류로) 연결된 src.
    for rf in relations or []:
        dst = rf.get("dst_id") if isinstance(rf, dict) else rf.dst_id
        rel = rf.get("relation") if isinstance(rf, dict) else rf.relation
        if dst is None:
            continue
        sub = select(EntityRelation.src_entity_id).where(
            EntityRelation.dst_entity_id == dst
        )
        if rel:
            sub = sub.where(EntityRelation.relation == rel)
        stmt = stmt.where(Entity.id.in_(sub))

    if year is not None:
        stmt = stmt.where(_temporal_year_filter(year))

    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0

    if sort == "created":
        stmt = stmt.order_by(Entity.created_at.desc())
    else:
        stmt = stmt.order_by(Entity.value)
    stmt = stmt.limit(limit).offset(offset)
    return list(db.execute(stmt).scalars()), total
