"""Business logic for reports — workspace scoping + widget-v1 validation."""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Iterable, Optional

from sqlalchemy import and_, case, desc, func, select
from sqlalchemy.orm import Session

from app.modules.composites.models import CompositeReport, CompositeReportItem
from app.modules.entities import services as entity_services
from app.modules.entities.models import Entity, ReportEntity
from app.modules.folders.models import Folder
from app.modules.grants import services as grant_services
from app.modules.grants.models import GrantContentType
from app.modules.mounts.models import ReportMount
from app.modules.reports.models import (
    Report,
    ReportEditLock,
    ReportLink,
    ReportLinkKind,
    ReportVersion,
)
from app.modules.reports.schemas import ReportCreate, ReportPage, ReportUpdate
from app.modules.reports import versioning
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
    include_descendants: bool = False,
    trashed: bool = False,
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
            # 소프트삭제(휴지통) 필터는 *개인 공간*에만 — 게시된 부서 게시판
            # 목록(org 분기)은 게시분을 그대로 보여줘 보존한다. trashed=True
            # 면 휴지통 보기(삭제된 것만).
            if trashed:
                query = query.where(Report.deleted_at.is_not(None))
            else:
                query = query.where(Report.deleted_at.is_(None))
        elif include_descendants:
            # Org workspace + descendant rollup — 상위 조직이 하위팀 게시글까지
            # 묶을 수 있게(예: 종합보고 안건 picker). 기본 게시판 목록은 이
            # 경로를 안 타고 아래 own-board 경로만 탄다.
            scope = ws_services.get_descendants_inclusive(db, workspace_slug)
            query = (
                query.join(ReportMount, ReportMount.report_id == Report.id)
                .where(ReportMount.workspace_slug.in_(scope))
                .distinct()
            )
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


def public_report_ids(db: Session) -> set[int]:
    """전체 공개(all_org)된 report_id 집합 — 콘텐츠 all_org ∪ 전체공개 게시판의
    보고서. 목록/그래프 대량 가시성·is_external_public 표시에 쓴다."""
    return grant_services.public_ids(db, GrantContentType.report)


def report_has_public_mount(db: Session, report_id: int) -> bool:
    """단일 보고서가 공개(all_org)인지 — 가벼운 EXISTS. (이름은 하위호환 유지)"""
    return grant_services.has_all_org_grant(db, GrantContentType.report, report_id)


def can_read_report(db: Session, actor, report: Report) -> bool:
    """단일 보고서 읽기 가시성 — grant 기반 통합 판정(소유·sys_admin·virtual·
    all_org·user grant·부서 grant 하위상속). public_viewer 는 공개분만."""
    return grant_services.can_view(
        db, actor, GrantContentType.report, report.id, report.owner_user_id
    )


def is_report_board_manager(db: Session, user_id: int, report: Report) -> bool:
    """이 보고서가 게시(mount)된 부서 게시판 중 하나라도 그 사용자가 매니저
    (역할 해석상 매니저 — 조상 부서 매니저 포함)인지. 게시 안 됐으면 게시판
    매니저는 없으니 False. 삭제 권한 판정용."""
    # 지역 import — _resolve_role 은 auth 레이어 leaf util 이라 모듈 상단에서
    # 끌어오면 순환 import 위험(grants/services 도 같은 패턴으로 지역 import).
    from app.modules.users.models import Role
    from app.shared.auth import _resolve_role

    slugs = db.execute(
        select(ReportMount.workspace_slug).where(ReportMount.report_id == report.id)
    ).scalars()
    for slug in slugs:
        if _resolve_role(db, user_id, slug) == Role.manager:
            return True
    return False


def can_delete_report(db: Session, actor, report: Report) -> bool:
    """삭제 권한 — 편집(can_edit)보다 좁다. 삭제는 보고서 원본을 지워 게시된
    모든 부서 게시판에서 cascade 로 사라지는 파괴적 작업이라, **소유자 /
    시스템 관리자 / 게시판 매니저**로 한정한다. coauthor(부서 edit grant)·
    추가편집자(user edit grant) 같은 편집권자는 삭제 불가."""
    user = actor.user
    if getattr(user, "is_system_admin", False):
        return True
    if report.owner_user_id == user.id:
        return True
    return is_report_board_manager(db, user.id, report)


def report_mount_count(db: Session, report_id: int) -> int:
    """이 보고서가 게시(mount)된 부서 게시판 수."""
    from app.modules.mounts.models import ReportMount

    return int(
        db.execute(
            select(func.count())
            .select_from(ReportMount)
            .where(ReportMount.report_id == report_id)
        ).scalar_one()
    )


def composite_ref_count(db: Session, report_id: int) -> int:
    """이 보고서를 안건으로 참조하는 종합보고 항목 수. 영구삭제 시
    CompositeReportItem.ref_report_id 가 CASCADE 라 함께 사라지므로, 삭제 전
    "종합보고 N건의 안건" 경고에 쓴다."""
    return int(
        db.execute(
            select(func.count())
            .select_from(CompositeReportItem)
            .where(CompositeReportItem.ref_report_id == report_id)
        ).scalar_one()
    )


def can_purge_report(db: Session, actor, report: Report) -> bool:
    """영구삭제(purge) 권한 — 소유자 / 시스템관리자만. 영구삭제는 원본을 지워
    게시된 모든 게시판·종합보고 안건에서 cascade 로 사라지는 비가역 작업이라,
    그 보고서를 소유한 사람만 할 수 있다(게시판 매니저는 자기 board 게시취소로
    다룬다). 단, 게시 중이면 라우트가 추가로 차단한다(게시취소 먼저)."""
    user = actor.user
    return bool(getattr(user, "is_system_admin", False)) or (
        report.owner_user_id == user.id
    )


def can_trash_report(db: Session, actor, report: Report) -> bool:
    """소프트삭제(휴지통) 권한 — 개인 공간에서 회수하는 행위라 **소유자 /
    시스템 관리자**만. 게시판 매니저는 자기 board 게시취소(unpublish)로
    다루지, 남의 개인 공간 보고서를 휴지통에 넣지 않는다."""
    user = actor.user
    return bool(getattr(user, "is_system_admin", False)) or (
        report.owner_user_id == user.id
    )


def soft_delete_report(db: Session, report: Report, actor) -> Report:
    """보고서를 휴지통으로 — deleted_at set. 개인 목록/검색에서 숨지만 게시된
    부서 게시판에는 그대로 남는다(게시분 보존). 이미 휴지통이면 무변경."""
    if report.deleted_at is None:
        report.deleted_at = datetime.utcnow()
        report.deleted_by_user_id = actor.user.id
        db.commit()
        db.refresh(report)
    return report


def restore_report(db: Session, report: Report) -> Report:
    """휴지통에서 복구 — deleted_at 해제 + 진행 중 게시취소 요청 자동 철회
    (복구=요청 철회). 지역 import 로 mounts 서비스를 끌어와 순환 import 회피."""
    if report.deleted_at is not None:
        report.deleted_at = None
        report.deleted_by_user_id = None
        from app.modules.mounts import services as mount_services

        mount_services.cancel_takedowns_for_report(db, report.id)
        db.commit()
        db.refresh(report)
    return report


def list_public_reports_on_board(
    db: Session,
    workspace_slug: str,
    *,
    entity_ids: Optional[list[int]] = None,
    folder_filter: Optional[int | str] = None,
) -> list[Report]:
    """이 게시판에 *배치(mount)*된 공개(all_org) 보고서 — 비멤버 외부 열람자
    (public_viewer)용. 전사 공개분 중 이 게시판에 올라온 것만(전사 공개 1건이
    모든 게시판을 채우지 않게). folder_filter 로 폴더 좁힘."""
    all_org = grant_services.all_org_ids(db, GrantContentType.report)
    if not all_org:
        return []
    mount_q = select(ReportMount.report_id).where(
        ReportMount.workspace_slug == workspace_slug,
        ReportMount.report_id.in_(all_org),
    )
    if folder_filter == "uncategorized":
        mount_q = mount_q.where(ReportMount.folder_id.is_(None))
    elif isinstance(folder_filter, int):
        mount_q = mount_q.where(ReportMount.folder_id == folder_filter)
    pub_ids = set(db.execute(mount_q).scalars())
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


def is_public_only_viewer(db: Session, actor, report: Report) -> bool:
    """이 사용자가 이 보고서를 *공개(all_org) 경로로만* 보고 있는가 — 읽기전용
    배너·곁다리(댓글·이력) 차단용. 멤버 경로(소유·user·부서 grant)로 보이면 False."""
    return grant_services.is_public_only_viewer(
        db, actor, GrantContentType.report, report.id, report.owner_user_id
    )


def _owned_report_ids(db: Session, user_id: int) -> set[int]:
    return set(
        db.execute(
            select(Report.id).where(Report.owner_user_id == user_id)
        ).scalars()
    )


def visible_report_ids(db: Session, actor) -> Optional[set[int]]:
    """actor 가 볼 수 있는 report_id 집합(grant ∪ 본인 소유). None=virtual 무스코프.
    목록 공개탐색·관계도 스코핑에 쓴다."""
    base = grant_services.visible_ids(db, actor, GrantContentType.report)
    if base is None:
        return None
    return base | _owned_report_ids(db, actor.user.id)


def search_snippet(text: Optional[str], query: str, radius: int = 60) -> Optional[str]:
    """검색어(여러 단어면 가장 먼저 등장하는 단어) 주변을 잘라 미리보기 스니펫으로
    (원문 케이스 유지). 단어 AND 검색이라 전체 문구는 안 붙어 있을 수 있어, 토큰 중
    가장 앞선 매치를 기준으로 한다."""
    if not text or not query:
        return None
    low = text.lower()
    tokens = [t for t in query.lower().split() if t] or [query.lower()]
    pos, matched = -1, ""
    for tok in tokens:
        p = low.find(tok)
        if p >= 0 and (pos < 0 or p < pos):
            pos, matched = p, tok
    if pos < 0:
        return None
    start = max(0, pos - radius)
    end = min(len(text), pos + len(matched) + radius)
    snippet = text[start:end].strip()
    if start > 0:
        snippet = "…" + snippet
    if end < len(text):
        snippet = snippet + "…"
    return snippet


def search_reports(
    db: Session,
    actor,
    query: str,
    *,
    limit: int = 30,
    offset: int = 0,
) -> tuple[list[Report], int]:
    """본문(search_text) + 제목 부분일치(pg_trgm ILIKE) 검색. 가시성 스코프 적용.

    스코프: public_viewer=이 게시판 공개분, virtual=무스코프(전체), 그 외=
    visible_report_ids(grant ∪ 소유). 정렬은 제목 매치 우선 → 최신순.
    Returns (rows, total).
    """
    needle = (query or "").strip()
    if not needle:
        return [], 0
    # 공백으로 단어 분리 → 각 단어를 AND(어디든 다 포함). "리스크 보고" 가 붙어
    # 있어야만 잡히던(문자열 통째 부분일치) 문제를 없앤다.
    tokens = [t for t in needle.split() if t]

    # 가시 스코프 — None=무스코프, set=허용 id. 빈 스코프면 즉시 0.
    scope_ids: Optional[set[int]]
    if getattr(actor, "public_viewer", False):
        scope_ids = {
            r.id for r in list_public_reports_on_board(db, actor.workspace.slug)
        }
        if not scope_ids:
            return [], 0
    elif getattr(actor.workspace, "virtual", False):
        scope_ids = None
    else:
        scope_ids = visible_report_ids(db, actor)
        if scope_ids is not None and not scope_ids:
            return [], 0

    conditions = [
        Report.deleted_at.is_(None),
        Report.search_text.isnot(None),
    ]
    # 단어마다 ILIKE 조건 → AND.
    for tok in tokens:
        conditions.append(Report.search_text.ilike(f"%{tok}%"))
    if scope_ids is not None:
        conditions.append(Report.id.in_(scope_ids))

    total = db.execute(select(func.count(Report.id)).where(*conditions)).scalar() or 0
    if total == 0:
        return [], 0

    # 제목에 모든 단어가 들어간 보고서를 위로.
    title_rank = case(
        (and_(*[Report.title.ilike(f"%{tok}%") for tok in tokens]), 0),
        else_=1,
    )
    rows = (
        db.execute(
            select(Report)
            .where(*conditions)
            .order_by(title_rank, desc(Report.updated_at))
            .offset(offset)
            .limit(limit)
        )
        .scalars()
        .all()
    )
    return list(rows), total


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
    if payload.page_default_view_mode is not None:
        init_kwargs["page_default_view_mode"] = payload.page_default_view_mode
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

    # 초기 버전(v1) 시드 — 이후 저장부터 이력이 쌓인다.
    versioning.record_version(db, report, source="save", author_user_id=owner_user_id)
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
    mode == "summary": "content" 와 동일하게 본문만 복사하되, 새(요약) 보고서를
                       원본과 'summary' kind 로 연결한다 (from=원본 → to=요약본).
                       원본=outgoing '요약본', 요약본=incoming '원본'.

    Never copies instance-bound data (mounts, comments, activities, owner
    locks, phase). report_date defaults to today (left unset). Files in the
    content are referenced by the same id — not deep-copied.
    """
    source = db.get(Report, source_report_id)
    if source is None:
        raise ValueError(f"원본 보고서를 찾을 수 없습니다: {source_report_id}")
    full = mode == "full"
    is_summary = mode == "summary"

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
        page_default_view_mode=source.page_default_view_mode,
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

    if is_summary:
        # 원본(source) → 요약본(new) 단방향 row 하나. 관계도 엣지가 원본→요약본
        # 으로 그려지고 forward_label('요약본')이 보인다. 보고서 상세는 양쪽 모두
        # 표시: 원본=outgoing '요약본', 요약본=incoming '원본'(list_links_for_report
        # 가 합쳐 줌). (from,to,kind) 는 새 보고서라 충돌 없음.
        db.add(
            ReportLink(
                from_report_id=source.id,
                to_report_id=new_report.id,
                kind="summary",
                note="",
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
    version_source: str = "save",
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
        "page_default_view_mode",
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

    # 본문 스냅샷(수정 이력) — 세션병합·무변경 dedup 내장. 같은 트랜잭션에 커밋.
    versioning.record_version(
        db, report, source=version_source, author_user_id=updated_by_user_id
    )

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


# ─── 버전(수정 이력) ───────────────────────────────────────────────────
def list_report_versions(
    db: Session, report_id: int, *, limit: int = 50, before_id: Optional[int] = None
) -> list[ReportVersion]:
    """최신순(id desc) + cursor(before_id). 본문(body_gzip)은 메모리·전송 비용 때문에
    목록에선 안 쓰지만 ORM 행 그대로 반환(라우트가 메타만 직렬화)."""
    q = select(ReportVersion).where(ReportVersion.report_id == report_id)
    if before_id is not None:
        q = q.where(ReportVersion.id < before_id)
    q = q.order_by(ReportVersion.id.desc()).limit(limit)
    return list(db.execute(q).scalars().all())


def get_report_version(
    db: Session, report_id: int, version_id: int
) -> Optional[ReportVersion]:
    return db.execute(
        select(ReportVersion).where(
            ReportVersion.id == version_id, ReportVersion.report_id == report_id
        )
    ).scalars().first()


def restore_version(
    db: Session, report: Report, version: ReportVersion, *, actor_user_id: int
) -> Report:
    """비파괴 되돌리기 — 되돌리기 직전 현재 상태를 스냅샷(되돌리기도 되돌릴 수
    있게)한 뒤, 그 버전의 본문을 새 저장으로 적용(revision +1). 적용 결과는
    'restore' 버전으로 기록. 호출부(라우트)가 권한·잠금을 먼저 확인한다."""
    body = versioning.decode_body(version)
    # 1) 현재 상태 보존(같으면 dedup skip).
    versioning.record_version(db, report, source="save", author_user_id=actor_user_id)
    # 2) 옛 본문 적용. (모델 이벤트 훅이 search_text 도 자동 재색인.)
    report.title = body.get("title") or report.title
    report.content = body.get("content") or {}
    report.layout_overrides = body.get("layout_overrides")
    report.props_overrides = body.get("props_overrides")
    report.pages = body.get("pages") or []
    report.updated_by_user_id = actor_user_id
    report.last_edited_by_user_id = actor_user_id
    report.last_edited_at = datetime.utcnow()
    report.revision = (report.revision or 1) + 1
    # 3) 복원 상태를 'restore' 마커 버전으로(prune 에서 보존됨).
    versioning.record_version(db, report, source="restore", author_user_id=actor_user_id)
    db.commit()
    db.refresh(report)
    return report


def delete_report(db: Session, report: Report) -> None:
    # 고아 grant 방지 — content_grant 는 FK CASCADE 가 없어 수동 정리.
    grant_services.delete_all_for_content(db, GrantContentType.report, report.id)
    # 종합보고 안건 처리: 발행 스냅샷(snapshot_content)이 있는 안건은 원본과
    # 분리(ref_report_id FK SET NULL)돼 스냅샷으로 살아남고(발행 종합보고 보존),
    # 스냅샷 없는(미발행/라이브) 안건은 여기서 함께 삭제한다 — 안 그러면 분리
    # 후 두 ref 모두 NULL 이면서 snapshot 도 없어 제약을 위반한다.
    refs = (
        db.execute(
            select(CompositeReportItem).where(
                CompositeReportItem.ref_report_id == report.id
            )
        )
        .scalars()
        .all()
    )
    for it in refs:
        if not it.snapshot_content:
            db.delete(it)
    db.flush()
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
    is_out_of_scope: bool = False,
) -> dict:
    """Report ORM → 관계도 노드 dict. owner 는 lazy='joined' 라 따라온다.
    is_external_public = 내 스코프 밖이지만 공개로 보이는 다른 조직 보고서(§7.2).
    is_out_of_scope = primary 스코프(이 부서/하위 게시분) 밖인데 링크로 끌려온
    외부 보고서(include_external)."""
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
        "is_out_of_scope": is_out_of_scope,
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


def _scoped_report_ids(db: Session, actor) -> Optional[set[int]]:
    """actor 가 볼 수 있는 보고서 id 집합(grant ∪ 소유). None = 무스코프(virtual).
    관계도 스코핑용 — `visible_report_ids` 와 동일."""
    return visible_report_ids(db, actor)


def build_global_link_graph(
    db: Session,
    *,
    actor,
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
    scope_mode: str = "subtree",
    include_external: bool = False,
    limit: int = LINK_GRAPH_GLOBAL_LIMIT,
) -> dict:
    """워크스페이스 범위의 글로벌 관계도 (지식그래프 Phase 1b/2/4).

    스코프(scope_mode): 'board'=이 게시판에 게시(mount)된 보고서만,
    'subtree'=이 게시판 + 하위 부서 게시판까지 롤업. (virtual 글로벌 뷰는
    무제한.) include_external=True 면 스코프 안 보고서와 *연결된* 스코프 밖
    보고서도 노드로 추가(권한상 볼 수 있는 것만, is_out_of_scope 로 표시).

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
    # 주 스코프(primary) = 이 부서(또는 +하위)에 *게시(mount)된* 보고서. 보고서
    # 목록과 같은 "게시된 것" 기준 — virtual 글로벌 뷰는 무제한(None).
    if is_global_view:
        primary_ids = None
    else:
        scope_slugs = (
            [workspace_slug]
            if scope_mode == "board"
            else ws_services.get_descendants_inclusive(db, workspace_slug)
        )
        primary_ids = set(
            db.execute(
                select(ReportMount.report_id).where(
                    ReportMount.workspace_slug.in_(scope_slugs)
                )
            ).scalars()
        )
    # 외부 노드(include_external)를 켤 때, 권한상 볼 수 있는 것만 허용(누수 방지).
    visible = _scoped_report_ids(db, actor)
    public_ids = public_report_ids(db) if not is_global_view else set()
    visible_all = None if visible is None else (visible | public_ids)
    type_set = set(type_ids) if type_ids else None

    def _is_primary(rid: int) -> bool:
        return primary_ids is None or rid in primary_ids

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

    # 적격 범위(scope_ids) = primary. include_external 면 primary 와 직접 연결된
    # *볼 수 있는* 스코프 밖 보고서까지 더한다. (virtual=무제한이면 None 유지.)
    if primary_ids is None:
        scope_ids = None
    else:
        scope_ids = set(primary_ids)
        if include_external:
            for lk in link_rows:
                f, t = lk.from_report_id, lk.to_report_id
                fp, tp = _is_primary(f), _is_primary(t)
                if fp and not tp and (visible_all is None or t in visible_all):
                    scope_ids.add(t)
                if tp and not fp and (visible_all is None or f in visible_all):
                    scope_ids.add(f)

    # 후보 보고서 = 연결된 것(endpoints) + (고립 표시면) 스코프 내 모든 보고서.
    candidate_ids: set[int] = set(endpoint_ids)
    if include_isolated:
        # 고립(연결 안 된) 노드는 *primary* 만 점으로 — 외부는 링크로만 등장.
        iso_q = select(Report.id)
        if primary_ids is not None:
            iso_q = iso_q.where(Report.id.in_(primary_ids))
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
        if lk.from_report_id in eligible
        and lk.to_report_id in eligible
        # 외부-외부(둘 다 스코프 밖) 엣지는 제외 — 최소 한 끝이 primary 여야.
        and (
            primary_ids is None
            or _is_primary(lk.from_report_id)
            or _is_primary(lk.to_report_id)
        )
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
                visible is not None
                and rid not in visible
                and rid in public_ids
            ),
            # primary(이 부서/하위 게시분) 밖인데 링크로 끌려온 노드 → 외부로 표시.
            is_out_of_scope=(primary_ids is not None and rid not in primary_ids),
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
