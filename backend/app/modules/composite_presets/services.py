"""Composite preset (종합보고 양식) services.

Snapshot a composite → preset, list presets visible to a workspace, and
instantiate a fresh composite from a preset. The instantiate path reuses
`composites.services.create` so composite-creation rules (ref validation,
workspace grant) stay in one place.
"""
from __future__ import annotations

from datetime import date as date_type
from typing import Optional

from sqlalchemy import desc, or_, select
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


def is_private_preset(preset: CompositePreset) -> bool:
    """개인(비공개) 양식 — 소유가 personal-* 뿐. 목록엔 소유자 본인만(instantiate
    는 id 로 열려 있음). templates/presets 와 동일 정의."""
    owners = preset.owner_workspace_slugs or []
    return bool(owners) and all(str(s).startswith("personal-") for s in owners)


def list_visible(
    db: Session,
    workspace_slug: str,
    *,
    all_scopes: bool = False,
    user_id: Optional[int] = None,
    is_system_admin: bool = False,
    include_archived: bool = False,
) -> list[CompositePreset]:
    """종합보고 양식 목록. 보고서 프리셋(presets.list_visible)과 동형 가시성:
      - 기본(scoped): 가시 트리 + 전사 + 내 개인 + 내가 만든 것(관리 분리 유지).
      - `all_scopes=True`(작성 picker): 소유 부서 무시 전체(모든 사용자가 모든 부서
        양식으로 시작 가능). 남의 개인(비공개)은 제외.
      - `is_system_admin=True`: 타인 개인 포함 전체.
    소유 부서는 분류/관리 메타일 뿐 — instantiate(new-composite)는 id 로 열려 있다."""
    # 보관 제외 필터(기본). 관리 화면이 보관 해제하려고 include_archived=True 로 부른다.
    def _archived_filter(q):
        return q if include_archived else q.where(CompositePreset.archived_at.is_(None))

    ordered = lambda q: list(  # noqa: E731
        db.execute(_archived_filter(q).order_by(desc(CompositePreset.updated_at))).scalars()
    )

    if is_system_admin:
        return ordered(select(CompositePreset))

    if all_scopes:
        rows = ordered(select(CompositePreset))
        mine = f"personal-{user_id}" if user_id is not None else None
        return [
            p
            for p in rows
            if not is_private_preset(p)
            or (mine is not None and mine in (p.owner_workspace_slugs or []))
        ]

    # scoped — global(owner=NULL) OR 가시 트리 겹침 OR 내 개인 OR 내가 만든 것.
    visible = _visible_slugs_for(db, workspace_slug)
    if user_id is not None:
        visible = visible | {f"personal-{user_id}"}
    conds = [CompositePreset.owner_workspace_slugs.is_(None)]
    if visible:
        conds.append(CompositePreset.owner_workspace_slugs.overlap(list(visible)))
    if user_id is not None:
        conds.append(CompositePreset.created_by_user_id == user_id)
    return ordered(select(CompositePreset).where(or_(*conds)))


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


def set_archived(
    db: Session,
    preset: CompositePreset,
    archived: bool,
    user_id: Optional[int] = None,
) -> CompositePreset:
    """보관/보관해제. 삭제와 달리 행을 지우지 않아 기존 종합보고엔 영향 없고,
    작성 picker·기본 목록에서만 빠진다. 멱등."""
    from datetime import datetime

    preset.archived_at = datetime.utcnow() if archived else None
    preset.archived_by_user_id = user_id if archived else None
    db.commit()
    db.refresh(preset)
    return preset


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
