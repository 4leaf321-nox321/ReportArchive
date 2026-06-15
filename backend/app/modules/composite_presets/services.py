"""Composite preset (종합보고 양식) services.

Snapshot a composite → preset, list presets visible to a workspace, and
instantiate a fresh composite from a preset. The instantiate path reuses
`composites.services.create` so composite-creation rules (ref validation,
workspace grant) stay in one place.
"""
from __future__ import annotations

from datetime import date as date_type
from typing import Optional

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.modules.composite_presets.models import CompositePreset
from app.modules.composite_presets.schemas import (
    CompositePresetCreate,
    CompositePresetInstantiate,
    CompositePresetUpdate,
)
from app.modules.composites import services as composite_services
from app.modules.composites.models import CompositeReport
from app.modules.composites.schemas import CompositeReportCreate
from app.modules.workspaces import services as ws_services


def _groups_from_items(composite: CompositeReport) -> list[str]:
    """Ordered, distinct non-empty group names as they appear top-to-bottom
    in the composite's items — first-seen wins (mirrors the frontend's
    section build in CompositeDetailPage.moveGroup). Only groups that have
    at least one saved item show up here; empty scaffold groups never
    reached the DB, so callers should prefer the client-supplied list."""
    out: list[str] = []
    seen: set[str] = set()
    for it in composite.items:
        gn = (it.group_name or "").strip()
        if gn and gn not in seen:
            seen.add(gn)
            out.append(gn)
    return out


def _build_seed(composite: CompositeReport, groups: list[str]) -> dict:
    """Snapshot everything a new composite should inherit: 요약 위젯,
    그룹 골격, 보기 모드, 설명. 안건(item refs) are intentionally left out —
    a preset is a starting scaffold, not a copy of the 회차 contents."""
    return {
        "summary_widgets": list(composite.summary_widgets or []),
        "groups": list(groups),
        "view_mode": composite.view_mode or "single",
        "description": composite.description or "",
    }


def _normalize_groups(groups: Optional[list[str]]) -> list[str]:
    """Trim, drop empties, dedupe (preserve order)."""
    out: list[str] = []
    seen: set[str] = set()
    for g in groups or []:
        t = (g or "").strip()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _visible_slugs_for(db: Session, workspace_slug: str) -> set[str]:
    """Slugs whose presets are visible from `workspace_slug` — the tree
    (ancestors + descendants). Mirrors presets._visible_slugs_for."""
    descendants = set(ws_services.get_descendants_inclusive(db, workspace_slug))
    ancestors = {a.slug for a in ws_services.get_ancestors(db, workspace_slug)}
    return {*descendants, *ancestors}


def create_from_composite(
    db: Session,
    source: CompositeReport,
    payload: CompositePresetCreate,
    *,
    created_by_user_id: int,
) -> CompositePreset:
    slugs = payload.owner_workspace_slugs or None
    if slugs is not None and len(slugs) == 0:
        slugs = None
    # Prefer the client-supplied skeleton (carries empty scaffold groups);
    # fall back to deriving from saved items when none was sent.
    groups = _normalize_groups(payload.groups) or _groups_from_items(source)
    kind = source.kind.value if hasattr(source.kind, "value") else source.kind
    preset = CompositePreset(
        name=payload.name,
        description=payload.description or "",
        source_kind=kind,
        owner_workspace_slugs=slugs,
        seed=_build_seed(source, groups),
        created_by_user_id=created_by_user_id,
    )
    db.add(preset)
    db.commit()
    db.refresh(preset)
    return preset


def list_visible(db: Session, workspace_slug: str) -> list[CompositePreset]:
    visible = _visible_slugs_for(db, workspace_slug)
    query = select(CompositePreset)
    # Global presets (owner = NULL) are always visible; scoped ones only
    # when their owner slugs intersect the actor's tree.
    if visible:
        query = query.where(
            (CompositePreset.owner_workspace_slugs.is_(None))
            | (CompositePreset.owner_workspace_slugs.overlap(list(visible)))
        )
    else:
        query = query.where(CompositePreset.owner_workspace_slugs.is_(None))
    return list(
        db.execute(query.order_by(desc(CompositePreset.updated_at))).scalars()
    )


def get(db: Session, preset_id: int) -> Optional[CompositePreset]:
    return db.get(CompositePreset, preset_id)


def update(
    db: Session,
    preset: CompositePreset,
    payload: CompositePresetUpdate,
) -> CompositePreset:
    """메타정보(name·description·공개범위) + 그룹 목록만 수정. 요약 위젯·
    보기설정은 손대지 않는다. exclude_unset 으로 보낸 필드만 반영한다."""
    data = payload.model_dump(exclude_unset=True)
    if data.get("name") is not None:
        preset.name = data["name"]
    if "description" in data and data["description"] is not None:
        preset.description = data["description"]
    if "owner_workspace_slugs" in data:
        slugs = data["owner_workspace_slugs"] or None
        if slugs is not None and len(slugs) == 0:
            slugs = None
        preset.owner_workspace_slugs = slugs
    if "groups" in data and data["groups"] is not None:
        # JSONB 변경 추적 — 새 dict 로 재할당해야 SQLAlchemy 가 dirty 로 인식.
        seed = dict(preset.seed or {})
        seed["groups"] = _normalize_groups(data["groups"])
        preset.seed = seed
    db.commit()
    db.refresh(preset)
    return preset


def delete(db: Session, preset: CompositePreset) -> None:
    db.delete(preset)
    db.commit()


def instantiate(
    db: Session,
    preset: CompositePreset,
    payload: CompositePresetInstantiate,
    *,
    owner_user_id: int,
) -> tuple[CompositeReport, list[str]]:
    """Create a fresh composite seeded from `preset`. Returns the new
    composite plus the preset's group skeleton — empty groups can't live
    in the DB (no item carries them yet), so the caller seeds them into
    the frontend's `pendingGroups` separately."""
    seed = preset.seed or {}
    groups = _normalize_groups(seed.get("groups"))
    create_payload = CompositeReportCreate(
        workspace_slug=payload.workspace_slug,
        title=payload.title,
        kind=payload.kind,
        period_date=(
            payload.period_date if payload.kind.value == "recurring" else None
        ),
        description=seed.get("description") or "",
        view_mode=seed.get("view_mode") or "single",
        two_col_view=(seed.get("view_mode") == "two_col"),
        summary_widgets=list(seed.get("summary_widgets") or []),
        # 빈 그룹 골격을 새 종합보고에 바로 영속 — 안건 배치/저장 전이나
        # 하드 새로고침에도 그룹이 사라지지 않게(예전엔 프론트 pendingGroups
        # 로만 존재해 휘발). seed_groups 반환은 즉시 표시용으로 유지.
        groups=groups,
        items=[],
    )
    composite = composite_services.create(
        db, create_payload, owner_user_id=owner_user_id
    )
    return composite, groups
