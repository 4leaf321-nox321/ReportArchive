"""Business logic for reports — workspace scoping + widget-v1 validation."""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Iterable, Optional

from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from app.modules.composites.models import CompositeReport, CompositeReportItem
from app.modules.entities import services as entity_services
from app.modules.entities.models import Entity, ReportEntity
from app.modules.folders.models import Folder
from app.modules.mounts.models import ReportMount
from app.modules.reports.models import (
    Report,
    ReportEditLock,
    ReportLink,
    ReportLinkKind,
)
from app.modules.reports.schemas import ReportCreate, ReportPage, ReportUpdate
from app.modules.users.models import User
from app.shared.link_kinds import is_valid_color
from app.modules.templates import services as template_services
from app.modules.workspaces import services as ws_services
from app.modules.workspaces.models import Workspace, WorkspaceKind
from app.widgets import (
    validate_layout_overrides as _validate_layout_overrides,
    validate_report_content as _validate_widget_v1_content,
)

# How long a lock survives without a heartbeat. Pairs with the frontend's
# 30s heartbeat (4x margin so a single dropped beat doesn't lose the lock).
LOCK_TTL = timedelta(seconds=120)


# --------------------------------------------------------------------------- #
# Edit-lock errors                                                            #
# --------------------------------------------------------------------------- #


class LockError(Exception):
    """Base class so the route layer can map any lock failure to 409.
    Subclasses carry a stable `code` string for the JSON error body — the
    frontend dispatches on this to choose the right UX (takeover dialog,
    refresh prompt, etc.)."""

    code: str = "lock_error"

    def __init__(self, message: str, *, holder: Optional[ReportEditLock] = None):
        super().__init__(message)
        self.holder = holder


class LockHeldByOtherError(LockError):
    """acquire_lock found a live lock owned by a different user. Caller can
    retry with `force=True` to take over."""

    code = "lock_held_by_other"


class LockNotHeldError(LockError):
    """The caller doesn't currently hold a live lock — either it expired,
    it was never acquired, or someone else took it over. Surfaces on
    heartbeat / release / save attempts."""

    code = "lock_not_held"


class RevisionMismatchError(LockError):
    """Caller's `expected_revision` doesn't match the row. Used as the
    optimistic safety net for the narrow window between forced takeover
    and the prior holder's stale save."""

    code = "revision_mismatch"


def _apply_entity_filter(db: Session, query, entity_ids: list[int]):
    """entity_ids 의 axis 별 AND / axis 내 OR 필터를 query 에 적용.
    유효한 id 가 하나도 없으면 None 을 반환(= 결과 0건). list_reports_in_workspace
    의 기본 경로와 공개 탐색 extra 경로가 공유한다."""
    rows = db.execute(
        select(Entity.id, Entity.type_id).where(Entity.id.in_(set(entity_ids)))
    ).all()
    by_type: dict[int, list[int]] = {}
    for entity_id, type_id in rows:
        by_type.setdefault(type_id, []).append(entity_id)
    # User explicitly asked to filter, but none of the supplied ids
    # exist — zero results rather than silently un-filtering.
    if not by_type:
        return None
    for ids_in_axis in by_type.values():
        subq = (
            select(ReportEntity.report_id)
            .where(
                ReportEntity.report_id == Report.id,
                ReportEntity.entity_id.in_(ids_in_axis),
            )
            .exists()
        )
        query = query.where(subq)
    return query


def list_reports_in_workspace(
    db: Session,
    workspace_slug: str,
    *,
    is_global_view: bool = False,
    entity_ids: Optional[list[int]] = None,
    folder_filter: Optional[int | str] = None,
    include_public: bool = False,
) -> list[Report]:
    """Returns reports visible in the given workspace.

    Two different visibility models depending on workspace kind:

      * **personal** (`kind='personal'`) — direct ownership. Returns
        reports whose `workspace_slug` equals the personal slug (i.e.
        reports the user authored / hasn't yet promoted). The personal
        space has no tree, so there's nothing to descend into.
      * **org** (`kind='org'`) — visibility via mount. Returns reports
        mounted to *this* workspace's own board only. Descendant
        (sub-team) mounts are NOT rolled up — each org board shows only
        the posts that belong to it.
      * **virtual** (`is_global_view=True`) — bypasses scoping entirely
        for cross-workspace admin views (the `_global` aggregate).

    `entity_ids` applies the N-axis tag filter on top: ids are grouped
    by their axis (entity.type_id), and the WHERE clause becomes
    `EXISTS(axis1 IN […]) AND EXISTS(axis2 IN […])` — i.e. *OR within
    an axis, AND across axes*. That matches standard tag-filter UX
    (Linear/Notion/Jira): picking two values in 모델 means "either
    model", while adding a 단계 narrows the result. An unknown id is
    silently dropped (defense in depth — the UI sends only ids it just
    got from /api/entities, but a stale URL could carry deleted ones).
    """
    query = select(Report).order_by(desc(Report.updated_at))
    ws = db.get(Workspace, workspace_slug) if not is_global_view else None
    if not is_global_view:
        # Resolve the workspace's kind once so we can branch the WHERE.
        # personal workspaces are leaf-only (no parent_slug semantics in
        # the user's tree), so we skip the descendants walk for them.
        if ws is not None and ws.kind == WorkspaceKind.personal:
            query = query.where(Report.workspace_slug == workspace_slug)
        else:
            # Org workspace: show only reports mounted to THIS workspace's
            # own board. We intentionally do NOT roll up descendant
            # (sub-team) mounts — each org board shows only its own posts.
            query = (
                query.join(ReportMount, ReportMount.report_id == Report.id)
                .where(ReportMount.workspace_slug == workspace_slug)
                .distinct()
            )
    # Folder filter — branches by scope. Personal: filter on
    # `Report.folder_id`. Org: filter on `ReportMount.folder_id` for
    # the current workspace specifically (so the filter only narrows
    # the just-joined mounts, not other mounts of the same report).
    if folder_filter is not None and ws is not None:
        if ws.kind == WorkspaceKind.personal:
            if folder_filter == "uncategorized":
                query = query.where(Report.folder_id.is_(None))
            elif isinstance(folder_filter, int):
                query = query.where(Report.folder_id == folder_filter)
        else:
            # Re-anchor the filter to the same JOIN already in the
            # query — ReportMount is bound to this query scope.
            if folder_filter == "uncategorized":
                query = query.where(
                    ReportMount.workspace_slug == workspace_slug,
                    ReportMount.folder_id.is_(None),
                )
            elif isinstance(folder_filter, int):
                query = query.where(
                    ReportMount.workspace_slug == workspace_slug,
                    ReportMount.folder_id == folder_filter,
                )
    if entity_ids:
        applied = _apply_entity_filter(db, query, entity_ids)
        if applied is None:
            return []
        query = applied
    results = list(db.execute(query).scalars())

    # 조직 간 공개 탐색(opt-in, 조직간공개_설계.md §5). org 컨텍스트에서만
    # "내 스코프 ∪ 공개분" 으로 넓힌다 — 기본(off)이면 자기 게시판 분만 보여
    # 목록 오염을 막는다(§5 "목록 vs 탐색 분리"). 폴더 필터가 걸린 게시판
    # 내부 탐색에는 적용 안 함(공개분은 다른 조직 폴더라 의미 없음).
    if (
        include_public
        and not is_global_view
        and ws is not None
        and ws.kind != WorkspaceKind.personal
        and folder_filter is None
    ):
        have = {r.id for r in results}
        extra_ids = public_report_ids(db) - have
        if extra_ids:
            extra_q = (
                select(Report)
                .where(Report.id.in_(extra_ids))
                .order_by(desc(Report.updated_at))
            )
            if entity_ids:
                extra_q = _apply_entity_filter(db, extra_q, entity_ids)
            if extra_q is not None:
                results.extend(db.execute(extra_q).scalars())
                results.sort(key=lambda r: r.updated_at, reverse=True)
    return results


def get_report(db: Session, report_id: int) -> Optional[Report]:
    return db.get(Report, report_id)


def _is_member_visible(db: Session, report: Report, workspace_slug: str) -> bool:
    """가시성 갈래 1·2 (멤버십 경로): 직접 소유 or descendant 트리 mount.
    공개(갈래 3)는 제외 — is_visible_to / is_public_only_viewer 가 조합한다."""
    # personal-space view: direct ownership only.
    if report.workspace_slug == workspace_slug:
        return True
    # org/virtual view: visible if mounted to any workspace inside the
    # actor's descendant scope. One small query — much cheaper than
    # walking every mount the report has.
    scope = ws_services.get_descendants_inclusive(db, workspace_slug)
    mount_exists = db.execute(
        select(ReportMount.report_id)
        .where(
            ReportMount.report_id == report.id,
            ReportMount.workspace_slug.in_(scope),
        )
        .limit(1)
    ).first()
    return mount_exists is not None


def _public_mount_query(*extra_where):
    """공개(external_view effective TRUE)인 mount 의 report_id 를 뽑는 공통
    select 빌더 (조직간공개_설계.md §3.2). effective 규칙:

        coalesce(folder.external_view, workspace.external_view_default)

    mount 에 folder 가 없거나(folder_id NULL → outer join 으로 NULL) folder 의
    external_view 가 NULL(상속)이면 게시판 기본값을 타고, 폴더가 TRUE/FALSE 면
    폴더가 이긴다. org 게시판만 의미 — personal/virtual 은 제외."""
    effective = func.coalesce(Folder.external_view, Workspace.external_view_default)
    return (
        select(ReportMount.report_id)
        .join(Workspace, Workspace.slug == ReportMount.workspace_slug)
        .outerjoin(Folder, Folder.id == ReportMount.folder_id)
        .where(
            Workspace.kind == WorkspaceKind.org,
            effective.is_(True),
            *extra_where,
        )
    )


def public_report_ids(db: Session) -> set[int]:
    """공개로 표시된 mount 를 하나라도 가진 report_id 집합(§4.4). 목록/그래프의
    대량 가시성 판정에 쓴다 — `_scoped_report_ids` 와 합쳐 "내 스코프 ∪ 공개분"."""
    return set(db.execute(_public_mount_query()).scalars())


def report_has_public_mount(db: Session, report_id: int) -> bool:
    """단일 보고서가 공개 mount 를 가졌는지 — 가벼운 EXISTS 쿼리."""
    return (
        db.execute(
            _public_mount_query(ReportMount.report_id == report_id).limit(1)
        ).first()
        is not None
    )


def is_visible_to(db: Session, report: Report, workspace_slug: str) -> bool:
    """Workspace visibility check — used by /api/reports/{id} and
    similar single-report routes.

    Match list_reports_in_workspace's branching: personal workspaces
    only see directly-owned reports; org workspaces see anything mounted
    within their descendant tree. 추가로 §3.1 갈래 3 — 공개(external_view)
    mount 를 하나라도 가진 보고서는 조직 경계와 무관하게 모든 인증 사용자에게
    가시(공개분은 항상 열람 가능).
    """
    return _is_member_visible(db, report, workspace_slug) or report_has_public_mount(
        db, report.id
    )


def can_read_report(db: Session, actor, report: Report) -> bool:
    """단일 보고서 읽기 가시성 — actor 컨텍스트까지 종합(조직간공개_설계 Phase 5).

    - virtual(글로벌/관리자) 컨텍스트: 전부 가시.
    - public_viewer(비멤버 외부 열람자): **공개분만** — is_visible_to 의 멤버십
      갈래(보고서가 이 게시판에 mount 됐다는 이유)로는 열리면 안 된다. 그래서
      엄격히 report_has_public_mount 로만 판정.
    - 그 외(멤버): 기존 is_visible_to(멤버십 ∪ 공개).

    actor 는 CurrentUser(덕타이핑: .workspace.virtual / .public_viewer /
    .workspace.slug)."""
    if getattr(actor.workspace, "virtual", False):
        return True
    if getattr(actor, "public_viewer", False):
        return report_has_public_mount(db, report.id)
    return is_visible_to(db, report, actor.workspace.slug)


def list_public_reports_on_board(
    db: Session,
    workspace_slug: str,
    *,
    entity_ids: Optional[list[int]] = None,
    folder_filter: Optional[int | str] = None,
) -> list[Report]:
    """이 게시판에 게시된 effective-public 보고서 목록 — 비멤버 외부 열람자
    (public_viewer)의 보고서 목록/폴더 필터용. 멤버용 list_reports_in_workspace
    와 달리 *공개 mount 만* 본다. folder_filter: int=그 폴더, 'uncategorized'=
    미분류(게시판 기본 공개일 때만 공개로 잡힘)."""
    pub_q = _public_mount_query(ReportMount.workspace_slug == workspace_slug)
    if folder_filter == "uncategorized":
        pub_q = pub_q.where(ReportMount.folder_id.is_(None))
    elif isinstance(folder_filter, int):
        pub_q = pub_q.where(ReportMount.folder_id == folder_filter)
    pub_ids = set(db.execute(pub_q).scalars())
    if not pub_ids:
        return []
    query = (
        select(Report)
        .where(Report.id.in_(pub_ids))
        .order_by(desc(Report.updated_at))
    )
    if entity_ids:
        query = _apply_entity_filter(db, query, entity_ids)
        if query is None:
            return []
    return list(db.execute(query).scalars())


def is_public_only_viewer(
    db: Session, report: Report, workspace_slug: str
) -> bool:
    """이 사용자가 이 보고서를 *공개 경로로만* 보고 있는가(조직간공개_설계.md §6).

    = 멤버십/mount(갈래 1·2)로는 안 보이는데 공개(갈래 3)로만 보이는 상태.
    댓글·수정이력 등 곁다리 차단 가드와 `_read_with_perms` 의 읽기전용 권한
    플래그에 쓴다. (멤버 열람자에겐 평소대로 곁다리가 열려야 하므로 갈래 1·2
    가 참이면 무조건 False.)"""
    if _is_member_visible(db, report, workspace_slug):
        return False
    return report_has_public_mount(db, report.id)


def _validate_page(db: Session, page: ReportPage) -> None:
    """Validate a single page's content + layout against its own template
    plus any per-page extra blocks the report added."""
    template = template_services.get_template(db, page.template_id, page.template_version)
    if not template:
        raise ValueError(
            f"Template not found: {page.template_id}@{page.template_version}"
        )
    if page.content:
        _validate_widget_v1_content(
            template.schema,
            page.content,
            extra_blocks=page.extra_blocks,
            props_overrides=page.props_overrides,
        )
    if page.layout_overrides:
        # Layout overrides may reference extra-block ids too; pass them
        # through as a synthetic schema so the validator accepts them.
        combined = _schema_with_extras(template.schema, page.extra_blocks)
        # When the page hides some template blocks via blocks_order, those
        # blocks aren't actually rendered — so their layouts should NOT
        # constrain the col_span row sums. Filter them out before passing
        # to the layout validator. (Validation already enforces that
        # blocks_order entries are known ids; we trust it here.)
        if page.blocks_order:
            order_set = set(page.blocks_order)
            combined = {
                **combined,
                "blocks": [
                    b for b in combined.get("blocks", []) if b["id"] in order_set
                ],
            }
        _validate_layout_overrides(combined, page.layout_overrides)
    if page.blocks_order:
        template_ids = {b["id"] for b in template.schema.get("blocks", [])}
        extra_ids = {b["id"] for b in page.extra_blocks or []}
        known = template_ids | extra_ids
        seen: set[str] = set()
        for bid in page.blocks_order:
            if not isinstance(bid, str):
                raise ValueError("blocks_order entries must be strings.")
            if bid not in known:
                raise ValueError(
                    f"blocks_order references unknown block id: {bid!r}"
                )
            if bid in seen:
                raise ValueError(f"blocks_order has duplicate id: {bid!r}")
            seen.add(bid)


def _schema_with_extras(template_schema: dict, extra_blocks: list[dict]) -> dict:
    """Returns a synthetic widget-v1 schema with the template's blocks +
    the page's extra_blocks. Used by validators that only know how to look
    up blocks by id on a single schema document."""
    if not extra_blocks:
        return template_schema
    return {
        **template_schema,
        "blocks": [*template_schema.get("blocks", []), *extra_blocks],
    }


def _validate_pages(db: Session, pages: Iterable[ReportPage]) -> None:
    pages = list(pages)
    if not pages:
        raise ValueError("Report must have at least one page")
    for page in pages:
        _validate_page(db, page)


def _normalize_overrides(overrides: dict | None) -> dict | None:
    """Treat empty dicts as None so the DB stays clean."""
    if not overrides:
        return None
    return overrides


def _sanitize_props_overrides(overrides: dict | None) -> dict | None:
    """Per-report prop overrides applied on top of the template's blocks.
    Previously locked to visual-style keys (text_style / depth_styles)
    only; now accepts any prop dict so the report writer can configure
    structural settings (table columns, KV items, etc.) on a per-report
    basis. The content validator below uses the effective (template ∪
    override) props when checking shape, so a structural override that
    invalidates existing content surfaces as a 400 at save time.

    Shape in/out: { "<block_id>": { any prop keys }, ... }
    Empty per-block dicts are pruned; an entirely empty result collapses
    to None to keep DB rows lean.
    """
    if not overrides or not isinstance(overrides, dict):
        return None
    out: dict[str, dict] = {}
    for block_id, raw in overrides.items():
        if not isinstance(block_id, str) or not isinstance(raw, dict):
            continue
        if raw:
            out[block_id] = raw
    return out or None


def _pages_to_jsonb(pages: list[ReportPage]) -> list[dict]:
    """Serialize ReportPage list into the JSONB shape stored on `Report.pages`.
    Empty `layout_overrides` is normalized to None to match the single-page
    column's convention."""
    return [
        {
            "template_id": p.template_id,
            "template_version": p.template_version,
            "name": (p.name or None),
            "content": p.content or {},
            "layout_overrides": _normalize_overrides(p.layout_overrides),
            "props_overrides": _sanitize_props_overrides(p.props_overrides),
            "extra_blocks": list(p.extra_blocks or []),
            "blocks_order": list(p.blocks_order or []),
            "block_sections": dict(p.block_sections or {}),
        }
        for p in pages
    ]


def _resolve_pages_for_create(payload: ReportCreate) -> list[ReportPage]:
    """Build the canonical page list for a create payload.

    If the client sent `pages`, use it verbatim (but enforce page 0 matches
    the top-level template — they're meant to be in sync). Otherwise
    synthesize a single page from the legacy single-template fields.
    """
    if payload.pages is not None:
        if not payload.pages:
            raise ValueError("`pages` cannot be empty")
        first = payload.pages[0]
        if (
            first.template_id != payload.template_id
            or first.template_version != payload.template_version
        ):
            raise ValueError(
                "pages[0] template must match the report's top-level template"
            )
        return list(payload.pages)
    return [
        ReportPage(
            template_id=payload.template_id,
            template_version=payload.template_version,
            content=payload.content or {},
            layout_overrides=payload.layout_overrides,
            props_overrides=payload.props_overrides,
        )
    ]


def _validate_collab_workspace_slugs(db: Session, slugs: list[str]) -> list[str]:
    """협업 부서 슬러그 정규화 — 중복 제거 + 실제 조직(비개인) 워크스페이스만
    남긴다. 입력 순서를 보존(프런트 표시 순서와 일치). 존재하지 않거나 개인
    워크스페이스인 슬러그는 조용히 버린다 — 부서 트리에서 고른 값이라 잘못될
    일이 드물고, 엔티티처럼 400 으로 막기보다 관대한 편이 안전하다."""
    if not slugs:
        return []
    seen: set[str] = set()
    ordered: list[str] = []
    for s in slugs:
        if s and s not in seen:
            seen.add(s)
            ordered.append(s)
    if not ordered:
        return []
    valid = set(
        db.execute(
            select(Workspace.slug).where(
                Workspace.slug.in_(ordered),
                Workspace.kind == WorkspaceKind.org,
            )
        ).scalars()
    )
    return [s for s in ordered if s in valid]


def create_report(
    db: Session,
    workspace_slug: str,
    payload: ReportCreate,
    owner_user_id: int,
) -> Report:
    pages = _resolve_pages_for_create(payload)
    _validate_pages(db, pages)

    page0 = pages[0]
    init_kwargs: dict = dict(
        workspace_slug=workspace_slug,
        template_id=page0.template_id,
        template_version=page0.template_version,
        title=payload.title,
        tags=list(payload.tags or []),
    )
    # Only pass report_date when the client explicitly supplied one;
    # leaving it out lets the column's CURRENT_DATE default fill in.
    if payload.report_date is not None:
        init_kwargs["report_date"] = payload.report_date
    if payload.phase is not None:
        init_kwargs["phase"] = payload.phase
    if payload.lifecycle is not None:
        init_kwargs["lifecycle"] = payload.lifecycle
    if payload.page_width_px is not None:
        init_kwargs["page_width_px"] = payload.page_width_px
    if payload.page_gap_px is not None:
        init_kwargs["page_gap_px"] = payload.page_gap_px
    if payload.page_blend_blocks is not None:
        init_kwargs["page_blend_blocks"] = payload.page_blend_blocks
    if payload.page_slide_guide is not None:
        init_kwargs["page_slide_guide"] = payload.page_slide_guide
    if payload.page_slide_ratio is not None:
        init_kwargs["page_slide_ratio"] = payload.page_slide_ratio
    if payload.page_slide_ratio_custom_w is not None:
        init_kwargs["page_slide_ratio_custom_w"] = payload.page_slide_ratio_custom_w
    if payload.page_slide_ratio_custom_h is not None:
        init_kwargs["page_slide_ratio_custom_h"] = payload.page_slide_ratio_custom_h
    if payload.page_rich_text_prefix_d0 is not None:
        init_kwargs["page_rich_text_prefix_d0"] = payload.page_rich_text_prefix_d0
    if payload.page_rich_text_prefix_d1 is not None:
        init_kwargs["page_rich_text_prefix_d1"] = payload.page_rich_text_prefix_d1
    if payload.page_rich_text_prefix_d2 is not None:
        init_kwargs["page_rich_text_prefix_d2"] = payload.page_rich_text_prefix_d2
    if payload.report_type_id is not None:
        init_kwargs["report_type_id"] = payload.report_type_id
    if payload.collab_workspace_slugs is not None:
        init_kwargs["collab_workspace_slugs"] = _validate_collab_workspace_slugs(
            db, payload.collab_workspace_slugs
        )
    report = Report(
        **init_kwargs,
        content=page0.content or {},
        layout_overrides=_normalize_overrides(page0.layout_overrides),
        props_overrides=_sanitize_props_overrides(page0.props_overrides),
        pages=_pages_to_jsonb(pages),
        owner_user_id=owner_user_id,
        # On a fresh report the creator is also the last editor — keeps
        # the column non-null so the UI never has to render "수정인: —"
        # for never-edited rows.
        updated_by_user_id=owner_user_id,
    )
    db.add(report)
    db.commit()
    db.refresh(report)

    # Entity tags — applied AFTER the initial commit so the report row
    # has its id. Validation happens inside set_report_entities (missing
    # ids raise ValueError → route maps to 400). Refresh again so the
    # eager-loaded `entities` relationship reflects the new links on the
    # response.
    if payload.entity_ids is not None:
        entity_services.set_report_entities(
            db, report_id=report.id, entity_ids=payload.entity_ids
        )
        db.commit()
        db.refresh(report)
    return report


def copy_report(
    db: Session,
    source_report_id: int,
    *,
    target_workspace: str,
    title: str,
    folder_id: Optional[int],
    mode: str,
    owner_user_id: int,
) -> Report:
    """Duplicate `source_report_id` into `target_workspace` (the caller's
    personal space). Centralizes *what* gets copied so new columns/relations
    don't get silently dropped by a hand-assembled client payload.

    mode == "content": pages + display settings only.
    mode == "full":    + tags, report_type, entity tags, lifecycle, and the
                       source's *outgoing* report_links (R→X ⇒ R'→X).

    Never copies instance-bound data (mounts, comments, activities, owner
    locks, phase). report_date defaults to today (left unset). Files in the
    content are referenced by the same id — not deep-copied.
    """
    source = db.get(Report, source_report_id)
    if source is None:
        raise ValueError(f"원본 보고서를 찾을 수 없습니다: {source_report_id}")
    full = mode == "full"

    # Validate the destination folder up front (belongs to the new owner) so
    # we don't create the copy and then fail to place it.
    if folder_id is not None:
        folder = db.get(Folder, folder_id)
        if folder is None or folder.user_id != owner_user_id:
            raise ValueError(f"폴더를 찾을 수 없거나 권한이 없습니다: {folder_id}")

    # Build a ReportCreate from the source. Display settings ride along in
    # both modes (a copy should *look* the same); metadata only in `full`.
    payload = ReportCreate(
        template_id=source.template_id,
        template_version=source.template_version,
        title=title,
        # report_date omitted → today's CURRENT_DATE default.
        pages=list(source.pages) if source.pages else None,
        content=source.content or {},
        layout_overrides=source.layout_overrides,
        props_overrides=source.props_overrides,
        page_width_px=source.page_width_px,
        page_gap_px=source.page_gap_px,
        page_blend_blocks=source.page_blend_blocks,
        page_slide_guide=source.page_slide_guide,
        page_slide_ratio=source.page_slide_ratio,
        page_slide_ratio_custom_w=source.page_slide_ratio_custom_w,
        page_slide_ratio_custom_h=source.page_slide_ratio_custom_h,
        page_rich_text_prefix_d0=source.page_rich_text_prefix_d0,
        page_rich_text_prefix_d1=source.page_rich_text_prefix_d1,
        page_rich_text_prefix_d2=source.page_rich_text_prefix_d2,
        tags=list(source.tags or []) if full else [],
        report_type_id=source.report_type_id if full else None,
        lifecycle=source.lifecycle if full else None,
        entity_ids=[e.id for e in source.entities] if full else None,
        collab_workspace_slugs=(
            list(source.collab_workspace_slugs or []) if full else None
        ),
    )
    new_report = create_report(
        db, target_workspace, payload, owner_user_id=owner_user_id
    )

    changed = False
    if folder_id is not None:
        new_report.folder_id = folder_id
        changed = True

    if full:
        # Copy only OUTGOING links (the relationships the source itself
        # declared). Incoming links belong to other reports and aren't
        # touched. Targets are guaranteed to exist (link rows cascade-delete
        # with their target), so a direct insert is safe — and the (from,
        # to, kind) unique constraint can't collide on a brand-new report.
        outgoing = (
            db.execute(
                select(ReportLink).where(
                    ReportLink.from_report_id == source.id
                )
            )
            .scalars()
            .all()
        )
        for link in outgoing:
            db.add(
                ReportLink(
                    from_report_id=new_report.id,
                    to_report_id=link.to_report_id,
                    kind=link.kind,
                    note=link.note,
                    created_by_user_id=owner_user_id,
                )
            )
            changed = True

    if changed:
        db.commit()
        db.refresh(new_report)
    return new_report


# --------------------------------------------------------------------------- #
# Edit lock — pessimistic, per-report, with TTL                               #
# --------------------------------------------------------------------------- #


def get_active_lock(
    db: Session, report: Report, *, now: Optional[datetime] = None
) -> Optional[ReportEditLock]:
    """Returns the lock row only if it's still live (not past expires_at).
    Returns None when there's no row, or the row exists but has expired —
    callers should treat both cases identically (no current holder).
    """
    now = now or datetime.utcnow()
    lock = report.edit_lock
    if lock is None:
        return None
    if lock.expires_at <= now:
        return None
    return lock


def acquire_lock(
    db: Session,
    report: Report,
    user_id: int,
    *,
    force: bool = False,
) -> ReportEditLock:
    """Claim the edit lock for `user_id`. Idempotent for the current holder
    (just refreshes the TTL), takes over expired locks automatically, and
    rejects live locks held by a different user unless `force=True`.

    Returns the (live) lock row. Caller is responsible for committing the
    session — this function flushes so the lock row is visible inside the
    same transaction as any follow-up reads.
    """
    now = datetime.utcnow()
    expires = now + LOCK_TTL
    existing = report.edit_lock
    if existing is not None and existing.expires_at > now and existing.user_id != user_id and not force:
        raise LockHeldByOtherError(
            "Report is currently being edited by another user.",
            holder=existing,
        )
    if existing is None:
        lock = ReportEditLock(
            report_id=report.id,
            user_id=user_id,
            acquired_at=now,
            expires_at=expires,
        )
        db.add(lock)
        report.edit_lock = lock
    else:
        # Same user refreshing, or force-takeover, or expired-and-reclaimed
        # — all three converge on "rewrite the row in place".
        existing.user_id = user_id
        existing.acquired_at = now
        existing.expires_at = expires
        lock = existing
    db.flush()
    return lock


def heartbeat_lock(
    db: Session, report: Report, user_id: int
) -> ReportEditLock:
    """Extend the TTL of an already-held lock. Fails if the caller doesn't
    own a live lock — that's the signal to the frontend that someone took
    over or the session expired, and the user should bail out of edit mode."""
    now = datetime.utcnow()
    lock = report.edit_lock
    if lock is None or lock.expires_at <= now or lock.user_id != user_id:
        raise LockNotHeldError(
            "Edit lock is no longer held by this user.",
            holder=lock if (lock is not None and lock.expires_at > now) else None,
        )
    lock.expires_at = now + LOCK_TTL
    db.flush()
    return lock


def release_lock(db: Session, report: Report, user_id: int) -> None:
    """Drop the lock if (and only if) `user_id` currently holds it. No-op
    when the lock is absent, expired, or held by someone else — releases
    must not be able to clobber another editor's session."""
    lock = report.edit_lock
    if lock is None:
        return
    now = datetime.utcnow()
    if lock.user_id != user_id or lock.expires_at <= now:
        return
    db.delete(lock)
    report.edit_lock = None
    db.flush()


def _require_lock_for_update(
    report: Report, user_id: int
) -> None:
    """Pre-check for update_report: caller must currently hold the lock.
    Raised before any DB mutation so a forced takeover (or expired lock)
    bails out without a partial write."""
    now = datetime.utcnow()
    lock = report.edit_lock
    if lock is None or lock.expires_at <= now or lock.user_id != user_id:
        raise LockNotHeldError(
            "You no longer hold the edit lock for this report. "
            "Reload to see the current state.",
            holder=lock if (lock is not None and lock.expires_at > now) else None,
        )


def update_report(
    db: Session,
    report: Report,
    payload: ReportUpdate,
    *,
    updated_by_user_id: Optional[int] = None,
    expected_revision: Optional[int] = None,
    require_lock: bool = True,
) -> Report:
    # Concurrency gates — both must pass before we touch anything. Lock
    # check first because a takeover invalidates revision assumptions too.
    if require_lock and updated_by_user_id is not None:
        _require_lock_for_update(report, updated_by_user_id)
    if expected_revision is not None and report.revision != expected_revision:
        raise RevisionMismatchError(
            f"Report has been modified by someone else "
            f"(client revision {expected_revision}, server revision {report.revision}).",
        )

    data = payload.model_dump(exclude_unset=True)

    # Resolve the new page list. Either the client sent the full `pages`
    # array (multi-page-aware), or they sent the legacy single-page
    # content / layout_overrides which we apply to page 0 in place.
    new_pages: Optional[list[ReportPage]] = None
    if "pages" in data:
        if not payload.pages:
            raise ValueError("`pages` cannot be empty")
        new_pages = list(payload.pages)
    elif "content" in data or "layout_overrides" in data or "props_overrides" in data:
        existing = list(report.pages or [])
        if not existing:
            # Defensive: should never happen post-migration, but keep
            # legacy updates working even on rows that pre-date it.
            existing = [
                {
                    "template_id": report.template_id,
                    "template_version": report.template_version,
                    "content": report.content or {},
                    "layout_overrides": report.layout_overrides,
                    "props_overrides": report.props_overrides,
                }
            ]
        # Mutate page 0 from legacy fields.
        page0 = dict(existing[0])
        if "content" in data:
            page0["content"] = data["content"] or {}
        if "layout_overrides" in data:
            page0["layout_overrides"] = _normalize_overrides(data["layout_overrides"])
        if "props_overrides" in data:
            page0["props_overrides"] = _sanitize_props_overrides(data["props_overrides"])
        existing[0] = page0
        new_pages = [ReportPage(**p) for p in existing]

    if new_pages is not None:
        _validate_pages(db, new_pages)
        page0 = new_pages[0]
        report.template_id = page0.template_id
        report.template_version = page0.template_version
        report.content = page0.content or {}
        report.layout_overrides = _normalize_overrides(page0.layout_overrides)
        report.props_overrides = _sanitize_props_overrides(page0.props_overrides)
        report.pages = _pages_to_jsonb(new_pages)

    # Apply non-page scalar fields. `report_type_id` is included so the
    # picker can both set and clear (explicit None) the tag in one PATCH.
    for key in (
        "title",
        "phase",
        "lifecycle",
        "closed_at",
        "folder_id",
        "report_date",
        "tags",
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
        "report_type_id",
    ):
        if key in data:
            setattr(report, key, data[key])

    # 협업 부서 — 전체 교체 집합. None/absent = 유지, [] = 해제. 슬러그는
    # 실제 조직 워크스페이스로 검증·정규화(중복 제거, 순서 보존).
    if "collab_workspace_slugs" in data:
        report.collab_workspace_slugs = _validate_collab_workspace_slugs(
            db, data["collab_workspace_slugs"] or []
        )

    # Stamp the last-editor. Done on every successful update path; routes
    # always pass the actor id so this never silently goes None.
    if updated_by_user_id is not None:
        report.updated_by_user_id = updated_by_user_id
        # Phase 3 — denormalized "last editor" for listing attribution.
        # Mirrors updated_by_* for now. Kept separate so future logic
        # (e.g. "owner edits don't count as 'last editor'") can diverge
        # without breaking legacy consumers of updated_by_*.
        from datetime import datetime as _dt

        report.last_edited_by_user_id = updated_by_user_id
        report.last_edited_at = _dt.utcnow()

    # Bump optimistic-concurrency counter. Every successful save advances
    # this, so any in-flight PATCH from a stale tab will hit
    # RevisionMismatchError on its next attempt.
    report.revision = (report.revision or 1) + 1

    db.commit()
    db.refresh(report)

    # Entity tags — handled after the main commit. We treat the supplied
    # list as a full replacement set (`None`/absent = no change, `[]` =
    # clear). Errors here propagate as ValueError and are mapped to 400
    # by the route layer; the report's scalar/page edits stay committed
    # so a bad entity id doesn't roll back the rest of the save.
    if "entity_ids" in data:
        entity_services.set_report_entities(
            db, report_id=report.id, entity_ids=data["entity_ids"] or []
        )
        db.commit()
        db.refresh(report)
    return report


def delete_report(db: Session, report: Report) -> None:
    db.delete(report)
    db.commit()


# --------------------------------------------------------------------------- #
# Report links — 보고서 간 의미 link                                          #
# --------------------------------------------------------------------------- #


class LinkError(Exception):
    """Service-layer link error — route 레이어가 400/404/409 로 매핑."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def list_links_for_report(db: Session, report_id: int) -> list[ReportLink]:
    """이 보고서의 outgoing + incoming link 를 한 번에 반환.

    프론트는 ``direction`` 필드로 둘을 구분 — 같은 row 가 양쪽에 따로
    나오는 게 아니라, 한 row 가 두 보고서 화면에서 각각 다른 라벨로
    보이는 식이다 (단방향 저장).
    """
    outgoing = list(
        db.execute(
            select(ReportLink).where(ReportLink.from_report_id == report_id)
        ).scalars()
    )
    incoming = list(
        db.execute(
            select(ReportLink).where(ReportLink.to_report_id == report_id)
        ).scalars()
    )
    return outgoing + incoming


def _kind_exists(db: Session, kind: str) -> bool:
    return (
        db.execute(
            select(ReportLinkKind.key).where(ReportLinkKind.key == kind)
        ).scalar_one_or_none()
        is not None
    )


def create_link(
    db: Session,
    *,
    from_report_id: int,
    to_report_id: int,
    kind: str,
    note: Optional[str],
    created_by_user_id: int,
) -> ReportLink:
    if from_report_id == to_report_id:
        raise LinkError("self_link", "보고서를 자기 자신과 연결할 수 없습니다.")
    if not _kind_exists(db, kind):
        raise LinkError("unknown_kind", f"알 수 없는 link 유형: {kind}")
    target = db.get(Report, to_report_id)
    if target is None:
        raise LinkError("target_not_found", "연결 대상 보고서를 찾을 수 없습니다.")
    # 중복 (from, to, kind) — UniqueConstraint 가 잡지만 친절한 메시지를 위해
    # 미리 한 번 조회.
    existing = db.execute(
        select(ReportLink).where(
            ReportLink.from_report_id == from_report_id,
            ReportLink.to_report_id == to_report_id,
            ReportLink.kind == kind,
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise LinkError("duplicate", "이미 같은 종류로 연결되어 있습니다.")
    link = ReportLink(
        from_report_id=from_report_id,
        to_report_id=to_report_id,
        kind=kind,
        note=(note or None),
        created_by_user_id=created_by_user_id,
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    return link


def delete_link(db: Session, link: ReportLink) -> None:
    db.delete(link)
    db.commit()


def get_link(db: Session, link_id: int) -> Optional[ReportLink]:
    return db.get(ReportLink, link_id)


# --------------------------------------------------------------------------- #
# Link graph — 보고서 관계도 (지식그래프 Phase 1a)                            #
# --------------------------------------------------------------------------- #

# 관계도 한 화면의 노드 상한 — Canvas force layout 이 부드럽게 도는 한계의
# 한참 아래로 둔 backstop. 로컬 그래프는 보통 수~수십 노드라 거의 닿지 않음.
# 닿으면 응답에 truncated=True 를 실어 프론트가 "더 좁히세요" 안내를 띄움.
LINK_GRAPH_MAX_NODES = 300

# 글로벌 관계도(Phase 1b) 노드 상한 — 넘으면 degree 높은 노드부터 잘라
# truncated=True. 로컬보다 크게 잡되 Canvas force layout 한계 아래로.
LINK_GRAPH_GLOBAL_LIMIT = 500


def _report_node(
    r: Report,
    *,
    degree: int,
    is_center: bool = False,
    is_external_public: bool = False,
) -> dict:
    """Report ORM → 관계도 노드 dict. owner 는 lazy='joined' 라 따라온다.
    is_external_public = 내 스코프 밖이지만 공개로 보이는 다른 조직 보고서(§7.2)."""
    return {
        "id": f"report:{r.id}",
        "type": "report",
        "report_id": r.id,
        "title": r.title,
        "owner_name": getattr(r.owner, "name", None) if r.owner else None,
        "workspace_slug": r.workspace_slug,
        "report_type_id": r.report_type_id,
        "report_date": r.report_date,
        "degree": degree,
        "is_center": is_center,
        "is_external_public": is_external_public,
    }


def _link_edge(lk: ReportLink) -> dict:
    return {
        "source": f"report:{lk.from_report_id}",
        "target": f"report:{lk.to_report_id}",
        "kind": lk.kind,
    }


def _entity_node(entity: Entity, *, degree: int) -> dict:
    """Entity ORM → 관계도 entity 노드. entity_type 은 lazy='joined'."""
    et = entity.entity_type
    return {
        "id": f"entity:{entity.id}",
        "type": "entity",
        "entity_id": entity.id,
        "label": entity.value,
        "axis": et.slug if et else None,
        "axis_label": et.label if et else None,
        "degree": degree,
    }


def _entity_layer(
    db: Session,
    report_ids: set[int],
    *,
    axes: Optional[set[str]] = None,
    min_degree: int = 1,
) -> tuple[list[dict], list[dict]]:
    """주어진 보고서들에 달린 관련정보(entity) 레이어 — (노드, has_tag 엣지).

    그래프에 이미 있는 report 들에만 entity 를 매단다 (새 보고서를 끌어오지
    않는다 — 토글로 켜는 '레이어' 성격 유지). report → entity 엣지의 kind 는
    고정 ``"has_tag"`` (프론트가 회색으로).

    부품처럼 값이 많은 축은 1회성 태그가 잎사귀로 매달려 헤어볼이 되므로
    두 가지로 거른다 (plan §2.1 개선):
      - ``axes``      : 보여줄 축(entity_type.slug) 집합. None = 전체.
      - ``min_degree``: *이 그래프 안에서* N개 이상 보고서가 공유한 태그만.
                        2 면 "여러 보고서를 잇는 허브"만 남아 1회성 잡음 제거.
    entity degree = 그래프 안에서 공유한 보고서 수 (허브일수록 큰 노드).
    """
    if not report_ids:
        return [], []
    rows = db.execute(
        select(ReportEntity.report_id, ReportEntity.entity_id).where(
            ReportEntity.report_id.in_(report_ids)
        )
    ).all()
    if not rows:
        return [], []
    # entity 별로 (그래프 안에서) 공유한 보고서 목록 — degree = 길이.
    reports_by_entity: dict[int, list[int]] = {}
    for rid, eid in rows:
        reports_by_entity.setdefault(eid, []).append(rid)
    entities = list(
        db.execute(select(Entity).where(Entity.id.in_(reports_by_entity))).scalars()
    )
    nodes: list[dict] = []
    edges: list[dict] = []
    for e in entities:
        if axes is not None:
            slug = e.entity_type.slug if e.entity_type else None
            if slug not in axes:
                continue
        rids = reports_by_entity.get(e.id, [])
        if len(rids) < min_degree:
            continue
        nodes.append(_entity_node(e, degree=len(rids)))
        for rid in rids:
            edges.append(
                {"source": f"report:{rid}", "target": f"entity:{e.id}", "kind": "has_tag"}
            )
    return nodes, edges


def _composite_node(c: CompositeReport, *, degree: int) -> dict:
    """CompositeReport ORM → 종합보고 hub 노드. owner 는 lazy='joined'."""
    return {
        "id": f"composite:{c.id}",
        "type": "composite",
        "composite_id": c.id,
        "title": c.title,
        "workspace_slug": c.workspace_slug,
        "owner_name": getattr(c.owner, "name", None) if c.owner else None,
        "composite_kind": c.kind.value if c.kind else None,
        "degree": degree,
    }


def _composite_layer(
    db: Session, report_ids: set[int]
) -> tuple[list[dict], list[dict]]:
    """주어진 보고서들을 안건으로 묶는 종합보고(composite) 레이어 — (노드,
    composite_member 엣지). entity 레이어와 같은 성격: 그래프에 이미 있는
    report 를 멤버로 가진 종합보고만 hub 노드로 띄우고, composite → member
    report 엣지(kind="composite_member")를 단다. degree = 그래프 안 멤버 수.
    """
    if not report_ids:
        return [], []
    rows = db.execute(
        select(
            CompositeReportItem.composite_id, CompositeReportItem.ref_report_id
        ).where(CompositeReportItem.ref_report_id.in_(report_ids))
    ).all()
    if not rows:
        return [], []
    members_by_comp: dict[int, list[int]] = {}
    for cid, rid in rows:
        members_by_comp.setdefault(cid, []).append(rid)
    composites = list(
        db.execute(
            select(CompositeReport).where(CompositeReport.id.in_(members_by_comp))
        ).scalars()
    )
    nodes: list[dict] = []
    edges: list[dict] = []
    for c in composites:
        rids = members_by_comp.get(c.id, [])
        nodes.append(_composite_node(c, degree=len(rids)))
        for rid in rids:
            edges.append(
                {
                    "source": f"composite:{c.id}",
                    "target": f"report:{rid}",
                    "kind": "composite_member",
                }
            )
    return nodes, edges


def build_link_graph(
    db: Session,
    center_report_id: int,
    *,
    depth: int = 2,
    max_nodes: int = LINK_GRAPH_MAX_NODES,
    include_tags: bool = False,
    tag_axes: Optional[list[str]] = None,
    tag_min_degree: int = 1,
    include_composites: bool = False,
) -> Optional[dict]:
    """중심 보고서에서 explicit link 를 따라 ±depth hop BFS 한 관계도.

    report 노드 + report↔report explicit_link 엣지가 기본. include_tags 면
    BFS 로 모인 보고서들의 관련정보(entity) 레이어를 더한다 (Phase 2). link
    은 방향이 있지만 BFS 는 양방향으로 확장한다 (선행/후속 어느 쪽이든 이웃).

    반환 shape (None 이면 center 보고서 없음):
        {
          "nodes": [LinkGraphNode-dict, ...],   # degree 채워짐
          "edges": [{source, target, kind}, ...],
          "truncated": bool,                     # max_nodes 에 걸렸는지
          "center_id": "report:<id>",
        }
    가시성 가드는 라우트 레이어 책임 — 여기선 순수하게 그래프만 만든다.
    """
    center = db.get(Report, center_report_id)
    if center is None:
        return None
    depth = max(1, min(depth, 3))

    # ── BFS: hop 단위로 frontier 를 한 번의 IN 쿼리로 확장 ────────────────
    visited: set[int] = {center_report_id}
    frontier: set[int] = {center_report_id}
    truncated = False
    for _ in range(depth):
        if not frontier:
            break
        rows = db.execute(
            select(ReportLink.from_report_id, ReportLink.to_report_id).where(
                ReportLink.from_report_id.in_(frontier)
                | ReportLink.to_report_id.in_(frontier)
            )
        ).all()
        next_frontier: set[int] = set()
        for from_id, to_id in rows:
            for nid in (from_id, to_id):
                if nid not in visited:
                    next_frontier.add(nid)
        if not next_frontier:
            break
        # 노드 상한 — 넘으면 들어갈 수 있는 만큼만 채우고 BFS 중단.
        if len(visited) + len(next_frontier) > max_nodes:
            for nid in next_frontier:
                if len(visited) >= max_nodes:
                    break
                visited.add(nid)
            truncated = True
            break
        visited |= next_frontier
        frontier = next_frontier

    # ── 엣지: 양 끝이 모두 visited 안인 link 만 (밖으로 매달리지 않게) ────
    link_rows = list(
        db.execute(
            select(ReportLink).where(
                ReportLink.from_report_id.in_(visited),
                ReportLink.to_report_id.in_(visited),
            )
        ).scalars()
    )
    edges: list[dict] = []
    degree: dict[int, int] = {rid: 0 for rid in visited}
    for lk in link_rows:
        edges.append(_link_edge(lk))
        degree[lk.from_report_id] += 1
        degree[lk.to_report_id] += 1

    # ── 노드: visited 보고서들. owner 는 lazy="joined" 라 같이 따라온다 ───
    report_rows = list(
        db.execute(select(Report).where(Report.id.in_(visited))).scalars()
    )
    nodes = [
        _report_node(
            r, degree=degree.get(r.id, 0), is_center=(r.id == center_report_id)
        )
        for r in report_rows
    ]

    # 관련정보 레이어 (Phase 2) — 토글 ON 일 때만. degree 는 report 쪽엔
    # 더하지 않아(엣지만 추가) 토글에 따라 보고서 노드 크기가 흔들리지 않는다.
    if include_tags:
        ent_nodes, ent_edges = _entity_layer(
            db,
            visited,
            axes=set(tag_axes) if tag_axes else None,
            min_degree=tag_min_degree,
        )
        nodes.extend(ent_nodes)
        edges.extend(ent_edges)

    # 종합보고 레이어 (Phase 4) — visited 보고서를 묶는 hub 노드.
    if include_composites:
        comp_nodes, comp_edges = _composite_layer(db, visited)
        nodes.extend(comp_nodes)
        edges.extend(comp_edges)

    return {
        "nodes": nodes,
        "edges": edges,
        "truncated": truncated,
        "center_id": f"report:{center_report_id}",
    }


def _scoped_report_ids(
    db: Session, workspace_slug: str, is_global_view: bool
) -> Optional[set[int]]:
    """워크스페이스에서 보이는 보고서 id 집합. None = 스코핑 없음(virtual
    글로벌 뷰). list_reports_in_workspace 의 가시성 분기와 동일한 규칙을
    id 만 가볍게 뽑아 재현한다 (personal: 직접 소유, org: 자기 게시판 mount —
    하위 워크스페이스 롤업 없음)."""
    if is_global_view:
        return None
    ws = db.get(Workspace, workspace_slug)
    if ws is not None and ws.kind == WorkspaceKind.personal:
        return set(
            db.execute(
                select(Report.id).where(Report.workspace_slug == workspace_slug)
            ).scalars()
        )
    return set(
        db.execute(
            select(ReportMount.report_id).where(
                ReportMount.workspace_slug == workspace_slug
            )
        ).scalars()
    )


def build_global_link_graph(
    db: Session,
    *,
    workspace_slug: str,
    is_global_view: bool = False,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    type_ids: Optional[list[int]] = None,
    kinds: Optional[list[str]] = None,
    entity_ids: Optional[list[int]] = None,
    include_tags: bool = False,
    tag_axes: Optional[list[str]] = None,
    tag_min_degree: int = 1,
    include_composites: bool = False,
    include_isolated: bool = False,
    limit: int = LINK_GRAPH_GLOBAL_LIMIT,
) -> dict:
    """워크스페이스 범위의 글로벌 관계도 (지식그래프 Phase 1b/2/4).

    로컬(build_link_graph)이 한 보고서에서 BFS 하는 것과 달리, 여기선
    *연결된 보고서들의 구조 전체* 를 그린다. 고립 노드(어떤 link 에도 안 낀
    보고서)는 기본 제외 — 글로벌 화면을 점 구름으로 만들지 않기 위해서다.
    include_isolated=True 면 필터에 맞는 스코프 내 모든 보고서를 점으로 더
    그린다(Phase 4 토글). 고립 노드는 degree 0 이라 limit 초과 시 가장 먼저
    잘린다(허브 우선 보존).

    필터:
      - date_from/date_to : report_date 범위
      - type_ids          : 보고서 종류 (OR)
      - kinds             : link kind (OR)
      - entity_ids        : 관련정보 — axis 별 AND, axis 안에서는 OR
                            (모델X AND 시험Y; plan §6.1)
    include_tags 면 살아남은 보고서들의 관련정보(entity) 레이어를 더한다.
    스코핑: is_global_view=False 면 actor 워크스페이스 트리 안 보고서로 한정
    (양 끝이 모두 스코프 안인 link 만). limit 초과 시 degree 높은 노드부터
    남기고 truncated=True.
    """
    # 스코프 = "내 스코프 ∪ 공개분"(조직간공개_설계.md §5). my_scope 는
    # 멤버십 가시 집합(virtual 글로벌 뷰면 None=제한 없음), public_ids 는
    # 공개로 표시된 보고서. 둘을 합쳐 그래프 적격 범위로 쓰고, 노드 표시는
    # "내 스코프 밖 + 공개" 면 다른 조직 공개 노드로 구분한다.
    my_scope = _scoped_report_ids(db, workspace_slug, is_global_view)
    public_ids = public_report_ids(db) if not is_global_view else set()
    scope_ids = None if my_scope is None else (my_scope | public_ids)
    type_set = set(type_ids) if type_ids else None

    # 시스템 전체 link (kind 필터만 SQL 로) — report_links 는 수동 생성이라
    # 작은 테이블. 스코프/날짜/종류 필터는 endpoint 보고서 단계에서 적용.
    edge_q = select(ReportLink)
    if kinds:
        edge_q = edge_q.where(ReportLink.kind.in_(kinds))
    link_rows = list(db.execute(edge_q).scalars())

    endpoint_ids: set[int] = set()
    for lk in link_rows:
        endpoint_ids.add(lk.from_report_id)
        endpoint_ids.add(lk.to_report_id)

    # 후보 보고서 = 연결된 것(endpoints) + (고립 표시면) 스코프 내 모든 보고서.
    candidate_ids: set[int] = set(endpoint_ids)
    if include_isolated:
        iso_q = select(Report.id)
        if scope_ids is not None:
            iso_q = iso_q.where(Report.id.in_(scope_ids))
        candidate_ids |= set(db.execute(iso_q).scalars())
    if not candidate_ids:
        return {"nodes": [], "edges": [], "truncated": False, "center_id": None}

    # entity 필터 — 선택값을 axis(type_id) 별로 묶어 AND, 묶음 안에서는 OR.
    # 후보 보고서별로 어떤 (선택된) entity 가 달렸는지 미리 적재.
    ent_groups: Optional[list[set[int]]] = None
    ent_hits: dict[int, set[int]] = {}
    if entity_ids:
        sel = db.execute(
            select(Entity.id, Entity.type_id).where(Entity.id.in_(entity_ids))
        ).all()
        groups: dict[int, set[int]] = {}
        for eid, type_id in sel:
            groups.setdefault(type_id, set()).add(eid)
        ent_groups = list(groups.values())
        if not ent_groups:  # 선택 id 가 전부 무효 → 매칭 보고서 없음
            return {"nodes": [], "edges": [], "truncated": False, "center_id": None}
        hit_rows = db.execute(
            select(ReportEntity.report_id, ReportEntity.entity_id).where(
                ReportEntity.report_id.in_(candidate_ids),
                ReportEntity.entity_id.in_([e for e, _ in sel]),
            )
        ).all()
        for rid, eid in hit_rows:
            ent_hits.setdefault(rid, set()).add(eid)

    reports = list(
        db.execute(select(Report).where(Report.id.in_(candidate_ids))).scalars()
    )

    def _eligible(r: Report) -> bool:
        if scope_ids is not None and r.id not in scope_ids:
            return False
        if date_from is not None and (
            r.report_date is None or r.report_date < date_from
        ):
            return False
        if date_to is not None and (
            r.report_date is None or r.report_date > date_to
        ):
            return False
        if type_set is not None and r.report_type_id not in type_set:
            return False
        if ent_groups is not None:
            hits = ent_hits.get(r.id, set())
            if any(hits.isdisjoint(group) for group in ent_groups):
                return False
        return True

    eligible: dict[int, Report] = {r.id: r for r in reports if _eligible(r)}

    kept_links = [
        lk
        for lk in link_rows
        if lk.from_report_id in eligible and lk.to_report_id in eligible
    ]

    def _degree(links: list[ReportLink], ids: set[int]) -> dict[int, int]:
        deg = {i: 0 for i in ids}
        for lk in links:
            deg[lk.from_report_id] += 1
            deg[lk.to_report_id] += 1
        return deg

    # 고립 표시면 적격 보고서 전체가 노드(연결 안 된 것은 점으로), 아니면
    # 살아남은 엣지의 양 끝만.
    if include_isolated:
        node_ids: set[int] = set(eligible.keys())
    else:
        node_ids = set()
        for lk in kept_links:
            node_ids.add(lk.from_report_id)
            node_ids.add(lk.to_report_id)
    degree = _degree(kept_links, node_ids)

    truncated = False
    if len(node_ids) > limit:
        # degree 높은 노드(허브)부터 남겨 관계 구조의 핵심을 보존.
        node_ids = set(
            sorted(node_ids, key=lambda i: degree[i], reverse=True)[:limit]
        )
        kept_links = [
            lk
            for lk in kept_links
            if lk.from_report_id in node_ids and lk.to_report_id in node_ids
        ]
        degree = _degree(kept_links, node_ids)
        truncated = True

    nodes = [
        _report_node(
            eligible[rid],
            degree=degree.get(rid, 0),
            # 내 스코프 밖인데 공개라서 보이는 노드 → 다른 조직 공개로 표시.
            is_external_public=(
                my_scope is not None
                and rid not in my_scope
                and rid in public_ids
            ),
        )
        for rid in node_ids
    ]
    edges = [_link_edge(lk) for lk in kept_links]

    # 관련정보 레이어 (Phase 2) — 살아남은 보고서 노드에만 entity 를 매단다.
    if include_tags:
        ent_nodes, ent_edges = _entity_layer(
            db,
            node_ids,
            axes=set(tag_axes) if tag_axes else None,
            min_degree=tag_min_degree,
        )
        nodes.extend(ent_nodes)
        edges.extend(ent_edges)

    # 종합보고 레이어 (Phase 4) — 살아남은 보고서를 묶는 hub 노드.
    if include_composites:
        comp_nodes, comp_edges = _composite_layer(db, node_ids)
        nodes.extend(comp_nodes)
        edges.extend(comp_edges)

    return {
        "nodes": nodes,
        "edges": edges,
        "truncated": truncated,
        "center_id": None,
    }


def is_linkable_target(db: Session, target: Report) -> bool:
    """Link 의 *대상* 으로 적합한지 — 다른 사용자에게 접근 권한이 있을
    가능성이 있는 보고서만 허용한다. 개인 워크스페이스 + 미게시 보고서는
    작성자 본인만 접근 가능하므로 link 대상으로 부적합 (다른 사용자가
    클릭해도 안 열림).

    OK 조건:
      - 작성된 워크스페이스가 org / virtual 인 경우 (= 조직 보고서),
      - 또는 어디든 mount(게시) 되어 있어 다른 워크스페이스 사용자에게도
        보이는 경우.
    """
    # Report 모델에 workspace relationship 이 정의돼 있지 않아 직접 조회.
    ws = db.get(Workspace, target.workspace_slug)
    if ws is not None and ws.kind != WorkspaceKind.personal:
        return True
    has_mount = (
        db.execute(
            select(ReportMount.report_id)
            .where(ReportMount.report_id == target.id)
            .limit(1)
        ).scalar_one_or_none()
        is not None
    )
    return has_mount


def _linkable_report_ids(db: Session) -> list[int]:
    """시스템 전체에서 link 대상 적격(=is_linkable_target 조건)인 보고서
    id 들을 한 번의 query 로. 가시성 제약 없음 — picker 는 actor 의 워크스페이스
    바깥에 있는 보고서도 검색할 수 있어야 한다 (개인 공간 사용자도 다른
    조직 보고서를 link 가능). 단일-테넌트 환경에서 자연스러운 정책.
    """
    rows = db.execute(
        select(Report.id)
        .join(Workspace, Report.workspace_slug == Workspace.slug)
        .where(
            (Workspace.kind != WorkspaceKind.personal)
            | Report.id.in_(select(ReportMount.report_id))
        )
    ).scalars()
    return list(rows)


def list_linkable_reports(db: Session) -> list[Report]:
    """Picker 의 후보 풀 — 전 시스템 linkable. order: updated_at DESC."""
    rows = db.execute(
        select(Report)
        .join(Workspace, Report.workspace_slug == Workspace.slug)
        .where(
            (Workspace.kind != WorkspaceKind.personal)
            | Report.id.in_(select(ReportMount.report_id))
        )
        .order_by(desc(Report.updated_at))
    ).scalars()
    return list(rows)


def list_linkable_facets(db: Session, actor) -> dict:
    """Link 대상으로 적격인 보고서들로부터 작성자 / 게시조직 옵션 카탈로그를
    한 번에 반환. picker 의 단순 옵션 채움용이라 응답이 가벼움 (수십 KB).

    actor 인자는 호환을 위해 받지만 현재 정책은 시스템 전체 linkable —
    개인 공간 사용자도 조직 보고서를 검색 가능해야 하기 때문.
    """
    del actor  # 시그니처 호환용 — 정책 변경 시 사용
    linkable_ids = _linkable_report_ids(db)
    if not linkable_ids:
        return {"authors": [], "mounts": []}

    # 작성자 집계 — Report 를 기준으로 join 해서 owner 가 없는 (anonymous /
    # 삭제된 사용자) 보고서는 자동 제외. select_from(Report) 으로 FROM 모호성도
    # 제거.
    author_rows = db.execute(
        select(User.name, func.count(Report.id).label("cnt"))
        .select_from(Report)
        .join(User, User.id == Report.owner_user_id)
        .where(Report.id.in_(linkable_ids))
        .group_by(User.name)
        .order_by(User.name)
    ).all()
    authors = [
        {"name": row[0], "count": int(row[1])} for row in author_rows
    ]

    # 게시조직 집계 — ReportMount 기준 join. ReportMount 는 composite PK
    # (report_id, workspace_slug) 라 `id` 컬럼이 없어 count(report_id) 사용.
    mount_rows = db.execute(
        select(
            Workspace.slug,
            Workspace.name,
            func.count(ReportMount.report_id).label("cnt"),
        )
        .select_from(ReportMount)
        .join(Workspace, Workspace.slug == ReportMount.workspace_slug)
        .where(ReportMount.report_id.in_(linkable_ids))
        .group_by(Workspace.slug, Workspace.name)
        .order_by(Workspace.name)
    ).all()
    mounts = [
        {"slug": row[0], "name": row[1], "count": int(row[2])}
        for row in mount_rows
    ]
    return {"authors": authors, "mounts": mounts}


# --------------------------------------------------------------------------- #
# Link kind catalog — admin-managed                                           #
# --------------------------------------------------------------------------- #


class LinkKindError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def list_link_kinds(db: Session) -> list[ReportLinkKind]:
    """sort_order ASC, key ASC. 칩/popover 가 그대로 순서대로 보여줌."""
    return list(
        db.execute(
            select(ReportLinkKind).order_by(
                ReportLinkKind.sort_order, ReportLinkKind.key
            )
        ).scalars()
    )


def get_link_kind(db: Session, key: str) -> Optional[ReportLinkKind]:
    return db.get(ReportLinkKind, key)


def create_link_kind(
    db: Session,
    *,
    key: str,
    forward_label: str,
    reverse_label: str,
    color: str,
    sort_order: int,
) -> ReportLinkKind:
    if not is_valid_color(color):
        raise LinkKindError(
            "invalid_color",
            f"허용되지 않은 색: {color} (blue/green/purple/amber/slate/rose/sky/teal/orange/pink 중 하나)",
        )
    if db.get(ReportLinkKind, key) is not None:
        raise LinkKindError("duplicate_key", f"이미 같은 key 의 라벨이 있습니다: {key}")
    row = ReportLinkKind(
        key=key,
        forward_label=forward_label,
        reverse_label=reverse_label,
        color=color,
        sort_order=sort_order,
        system_locked=False,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def update_link_kind(
    db: Session,
    kind: ReportLinkKind,
    *,
    forward_label: Optional[str] = None,
    reverse_label: Optional[str] = None,
    color: Optional[str] = None,
    sort_order: Optional[int] = None,
) -> ReportLinkKind:
    """라벨/색/순서 변경. system_locked 행도 라벨/색은 바꿀 수 있다 — key
    와 row 자체만 immutable. 빈 값은 그대로 둠."""
    if color is not None:
        if not is_valid_color(color):
            raise LinkKindError(
                "invalid_color",
                f"허용되지 않은 색: {color}",
            )
        kind.color = color
    if forward_label is not None:
        kind.forward_label = forward_label
    if reverse_label is not None:
        kind.reverse_label = reverse_label
    if sort_order is not None:
        kind.sort_order = sort_order
    db.commit()
    db.refresh(kind)
    return kind


def delete_link_kind(db: Session, kind: ReportLinkKind) -> None:
    """system_locked 거부, 사용 중이면 거부. 둘 다 LinkKindError."""
    if kind.system_locked:
        raise LinkKindError(
            "system_locked",
            "기본 제공 라벨이라 삭제할 수 없습니다 (라벨/색은 편집 가능).",
        )
    in_use = db.execute(
        select(ReportLink).where(ReportLink.kind == kind.key).limit(1)
    ).scalar_one_or_none()
    if in_use is not None:
        # 사용 중 — admin 이 먼저 해당 link 들을 다른 kind 로 옮기든 끊든
        # 한 다음 다시 시도해야 한다.
        raise LinkKindError(
            "in_use",
            "이 라벨을 사용하는 link 가 있어 삭제할 수 없습니다. 먼저 해당 link 들을 정리하세요.",
        )
    db.delete(kind)
    db.commit()
