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

from app.modules.entities.models import (
    Entity,
    EntityStatus,
    EntityType,
    ReportEntity,
)
from app.modules.entities.schemas import EntityCreate, EntityUpdate


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


def list_entities(
    db: Session,
    *,
    type_id: Optional[int] = None,
    q: Optional[str] = None,
    include_deprecated: bool = False,
    limit: int = 200,
    with_usage: bool = False,
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

    existing = find_by_value_ci(db, type_id=payload.type_id, value=value)
    if existing is not None:
        # Picker calls POST optimistically — return the canonical row so
        # the caller links to the existing one instead of getting a 409.
        return existing

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
