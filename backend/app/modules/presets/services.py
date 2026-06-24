"""Report preset (시작 양식) services.

Snapshot a report → preset, list presets visible to a workspace, and
instantiate a fresh report from a preset. The instantiate path reuses
`reports.services.create_report` so all the report-creation rules
(validation, entity tagging, page resolution) stay in one place.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import desc, or_, select
from sqlalchemy.orm import Session

from app.modules.entities import services as entity_services
from app.modules.presets.models import ReportPreset
from app.modules.presets.schemas import PresetCreate
from app.modules.report_types import services as report_type_services
from app.modules.reports import services as report_services
from app.modules.reports.models import Report
from app.modules.reports.schemas import ReportCreate
from app.modules.workspaces import services as ws_services

# Display/look fields that travel with the seed (mirrors copy_report).
_DISPLAY_FIELDS = (
    "page_width_px",
    "page_gap_px",
    "page_blend_blocks",
    "page_slide_guide",
    "page_slide_ratio",
    "page_slide_ratio_custom_w",
    "page_slide_ratio_custom_h",
    "page_rich_text_prefix_d0",
    "page_rich_text_prefix_d1",
    "page_rich_text_prefix_d2",
)


def _build_seed(report: Report) -> dict:
    """Snapshot everything a new report should inherit from this one:
    pages (본문·레이아웃), tags, report type, entity tags, and display
    settings. Instance-bound data (mounts/comments/owner/locks) is left
    out — a preset is a starting point, not a copy of the instance."""
    seed: dict = {
        "pages": list(report.pages or []),
        "content": report.content or {},
        "layout_overrides": report.layout_overrides,
        "props_overrides": report.props_overrides,
        "tags": list(report.tags or []),
        "report_type_id": report.report_type_id,
        "entity_ids": [e.id for e in report.entities],
    }
    for f in _DISPLAY_FIELDS:
        seed[f] = getattr(report, f, None)
    return seed


def _visible_slugs_for(db: Session, workspace_slug: str) -> set[str]:
    """Slugs whose presets are visible from `workspace_slug` — the tree
    (ancestors + descendants). Mirrors templates._visible_slugs_for."""
    descendants = set(ws_services.get_descendants_inclusive(db, workspace_slug))
    ancestors = {a.slug for a in ws_services.get_ancestors(db, workspace_slug)}
    return {*descendants, *ancestors}


def create_from_report(
    db: Session,
    source: Report,
    payload: PresetCreate,
    *,
    created_by_user_id: int,
) -> ReportPreset:
    slugs = payload.owner_workspace_slugs or None
    if slugs is not None and len(slugs) == 0:
        slugs = None
    preset = ReportPreset(
        name=payload.name,
        description=payload.description or "",
        template_id=source.template_id,
        template_version=source.template_version,
        owner_workspace_slugs=slugs,
        seed=_build_seed(source),
        created_by_user_id=created_by_user_id,
    )
    db.add(preset)
    db.commit()
    db.refresh(preset)
    return preset


def is_private_preset(preset: ReportPreset) -> bool:
    """개인(비공개) 프리셋 — 소유가 personal-* 뿐. 목록엔 소유자 본인만(렌더/사용
    경로는 id 로 열려 있음). templates.is_private_template 와 동일 정의."""
    owners = preset.owner_workspace_slugs or []
    return bool(owners) and all(str(s).startswith("personal-") for s in owners)


def list_visible(
    db: Session,
    workspace_slug: str,
    *,
    template_id: Optional[str] = None,
    all_scopes: bool = False,
    user_id: Optional[int] = None,
    is_system_admin: bool = False,
) -> list[ReportPreset]:
    """프리셋 목록. 템플릿(list_templates)과 동형 가시성:
      - 기본(scoped): 현재 워크스페이스 가시 트리 + 전사 + 내 개인 + 내가 만든 것.
      - `all_scopes=True`(작성 picker): 소유 부서 무시 전체(모든 사용자가 내 공간
        에서 모든 부서 프리셋으로 시작 가능). 단 남의 개인(비공개) 프리셋은 제외.
      - `is_system_admin=True`: 타인 개인 포함 전체.
    소유 부서는 *분류/관리* 메타일 뿐 사용 가드가 아니다(instantiate 는 id 로 열림)."""
    base = select(ReportPreset)
    if template_id is not None:
        base = base.where(ReportPreset.template_id == template_id)
    ordered = lambda q: list(  # noqa: E731
        db.execute(q.order_by(desc(ReportPreset.updated_at))).scalars()
    )

    if is_system_admin:
        return ordered(base)

    if all_scopes:
        rows = ordered(base)
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
    conds = [ReportPreset.owner_workspace_slugs.is_(None)]
    if visible:
        conds.append(ReportPreset.owner_workspace_slugs.overlap(list(visible)))
    if user_id is not None:
        conds.append(ReportPreset.created_by_user_id == user_id)
    return ordered(base.where(or_(*conds)))


def get(db: Session, preset_id: int) -> Optional[ReportPreset]:
    return db.get(ReportPreset, preset_id)


def delete(db: Session, preset: ReportPreset) -> None:
    db.delete(preset)
    db.commit()


def instantiate(
    db: Session,
    preset: ReportPreset,
    *,
    target_workspace: str,
    title: Optional[str],
    folder_id: Optional[int],
    owner_user_id: int,
) -> Report:
    """Create a fresh report seeded from `preset`. Stale references in the
    seed (entity/type deleted since the preset was saved) are dropped
    rather than failing the whole create."""
    seed = preset.seed or {}

    # Validate the destination folder belongs to the new owner before we
    # create the report (mirrors copy_report).
    if folder_id is not None:
        from app.modules.folders.models import Folder

        folder = db.get(Folder, folder_id)
        if folder is None or folder.user_id != owner_user_id:
            raise ValueError(f"폴더를 찾을 수 없거나 권한이 없습니다: {folder_id}")

    # Drop entity ids that no longer exist so set_report_entities doesn't
    # reject the whole payload.
    raw_entity_ids = seed.get("entity_ids") or []
    entity_ids: Optional[list[int]] = None
    if raw_entity_ids:
        existing = {e.id for e in entity_services.list_by_ids(db, list(raw_entity_ids))}
        entity_ids = [eid for eid in raw_entity_ids if eid in existing]

    # Drop a stale report_type_id (controlled vocabulary may have changed).
    report_type_id = seed.get("report_type_id")
    if report_type_id is not None and report_type_services.get(db, report_type_id) is None:
        report_type_id = None

    pages = seed.get("pages") or None

    payload = ReportCreate(
        template_id=preset.template_id,
        template_version=preset.template_version,
        title=(title or preset.name),
        pages=pages,
        content=seed.get("content") or {},
        layout_overrides=seed.get("layout_overrides"),
        props_overrides=seed.get("props_overrides"),
        tags=list(seed.get("tags") or []),
        report_type_id=report_type_id,
        entity_ids=entity_ids,
        **{f: seed.get(f) for f in _DISPLAY_FIELDS},
    )
    report = report_services.create_report(
        db, target_workspace, payload, owner_user_id=owner_user_id
    )
    if folder_id is not None:
        report.folder_id = folder_id
        db.commit()
        db.refresh(report)
    return report
