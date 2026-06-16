"""Business logic for composite reports."""
from __future__ import annotations

from datetime import datetime
from typing import Iterable, Optional

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.modules.composites.models import (
    CompositeItemRequest,
    CompositeItemRequestStatus,
    CompositeKind,
    CompositeReport,
    CompositeReportItem,
)
from app.modules.composites.schemas import (
    CompositeItemPayload,
    CompositeReportCreate,
    CompositeReportUpdate,
)
from app.modules.notifications.models import NotificationType
from app.modules.notifications.services import create_notification
from app.modules.grants import services as grant_services
from app.modules.grants.models import GrantContentType
from app.modules.reports.models import Report
from app.modules.workspaces import services as ws_services
from app.modules.workspaces.models import Workspace, WorkspaceKind


class CompositeError(Exception):
    code = "composite_error"
    status_code = 400


class CompositeForbiddenError(CompositeError):
    code = "composite_forbidden"
    status_code = 403


class CompositeConflictError(CompositeError):
    """낙관적 동시성 충돌 — 클라이언트의 expected_revision 이 서버와 다름
    (다른 사람이 먼저 저장). 프런트는 409 를 받으면 최신본을 다시 불러온다."""

    code = "composite_revision_mismatch"
    status_code = 409


def list_in_workspace_tree(
    db: Session, workspace_slug: str, *, is_global_view: bool = False
) -> list[CompositeReport]:
    """이 게시판(home board)에 속한 종합보고 목록. 공유/권한 개편: 하위 롤업
    제거 — 부모 게시판이 자식 팀 종합보고를 목록에 자동으로 띄우지 않는다
    (가시성은 grant 로 별도 판정; 자식에 공유하면 부모 목록엔 안 뜸).
    virtual(글로벌)은 전체."""
    q = select(CompositeReport).order_by(desc(CompositeReport.updated_at))
    if not is_global_view:
        q = q.where(CompositeReport.workspace_slug == workspace_slug)
    return list(db.execute(q).scalars())


def list_containing_report(
    db: Session, report_id: int
) -> list[CompositeReport]:
    """Every composite that references the given report as an item.
    Powers the report-detail "포함된 종합 N개" chip (Phase 5C).

    Sort: published_at DESC NULLS LAST (most recent publish first), then
    updated_at DESC as tiebreaker. recurring drafts come last because
    they're still being worked on; published ones first because that's
    what a viewer mostly cares about ("어디 인용됐지?").
    """
    q = (
        select(CompositeReport)
        .join(
            CompositeReportItem,
            CompositeReportItem.composite_id == CompositeReport.id,
        )
        .where(CompositeReportItem.ref_report_id == report_id)
        .order_by(
            desc(CompositeReport.published_at).nullslast(),
            desc(CompositeReport.updated_at),
        )
        .distinct()
    )
    return list(db.execute(q).scalars())


def get(db: Session, composite_id: int) -> Optional[CompositeReport]:
    return db.get(CompositeReport, composite_id)


def is_visible_to(db: Session, composite: CompositeReport, workspace_slug: str) -> bool:
    """부서 grant 가 이 게시판 W 에 도달하나(하위 상속, all_org 제외) — 코어
    스코프 게이트. 단일-콘텐츠 actor 판정은 can_read_composite 를 쓴다."""
    return grant_services.reachable_workspace_view(
        db, GrantContentType.composite, composite.id, workspace_slug
    )


def composite_is_public(db: Session, composite: CompositeReport) -> bool:
    """이 종합보고가 조직 간 공개(all_org grant)인가 — 공유/권한 개편."""
    return grant_services.has_all_org_grant(
        db, GrantContentType.composite, composite.id
    )


def can_read_composite(db: Session, actor, composite: CompositeReport) -> bool:
    """단일 종합보고 읽기 가시성 — grant 기반 통합(소유·sys_admin·virtual·
    all_org·user grant·부서 grant 하위상속). public_viewer 는 공개분만."""
    return grant_services.can_view(
        db, actor, GrantContentType.composite, composite.id, composite.owner_user_id
    )


def can_edit_composite(db: Session, user, composite: CompositeReport) -> bool:
    """종합보고 편집 가능 여부 — grant 기반(sys_admin·owner·user edit·부서 edit
    하위도달). 보고서 can_edit 와 동형(종합보고엔 author_lock 없음)."""
    return grant_services.can_edit_grant(
        db, user, GrantContentType.composite, composite.id, composite.owner_user_id
    )


def is_public_only_viewer(db: Session, actor, composite: CompositeReport) -> bool:
    """이 사용자가 이 종합보고를 *공개(all_org) 경로로만* 보고 있는가 — 읽기전용
    배너·곁다리 차단용. 멤버 경로(소유·user·부서 grant)로 보이면 False."""
    return grant_services.is_public_only_viewer(
        db, actor, GrantContentType.composite, composite.id, composite.owner_user_id
    )


def list_public_composites_on_board(
    db: Session, workspace_slug: str
) -> list[CompositeReport]:
    """이 게시판에 속한 공개(all_org) 종합보고만 — 비멤버 외부 열람자용."""
    all_org = grant_services.all_org_ids(db, GrantContentType.composite)
    if not all_org:
        return []
    q = (
        select(CompositeReport)
        .where(
            CompositeReport.workspace_slug == workspace_slug,
            CompositeReport.id.in_(all_org),
        )
        .order_by(desc(CompositeReport.updated_at))
    )
    return list(db.execute(q).scalars())


def list_visible_composites_on_board(
    db: Session, actor
) -> list[CompositeReport]:
    """비멤버(public_viewer)용 — 이 게시판(home board)의 종합보고 중 actor 가 볼
    수 있는 것. 보고서 list_visible_reports_on_board 와 동형: grant 기반(전체공개
    ∪ 사용자/게시판/폴더 grant, 멤버십 기반)으로 좁힌 visible_ids 와 home board
    교집합. list_public_composites_on_board(공개분만)의 일반화 — 공유받은 부서가
    종합보고를 브라우즈할 수 있게 한다(소유·자동 grant 제외, can_view 와 일치)."""
    visible = grant_services.visible_ids(db, actor, GrantContentType.composite)
    if visible is not None and not visible:
        return []
    q = select(CompositeReport).where(
        CompositeReport.workspace_slug == actor.workspace.slug
    )
    if visible is not None:
        q = q.where(CompositeReport.id.in_(visible))
    q = q.order_by(desc(CompositeReport.updated_at))
    return list(db.execute(q).scalars())


def _validate_refs(
    db: Session,
    items: Iterable[CompositeItemPayload],
    *,
    self_id: Optional[int] = None,
) -> None:
    """Ensure every item references something that actually exists, and
    block self-references so a composite can't contain itself."""
    for item in items:
        if item.ref_report_id is not None:
            if db.get(Report, item.ref_report_id) is None:
                raise ValueError(f"Report not found: {item.ref_report_id}")
        else:
            if item.ref_composite_id is None:
                # Schema validator already enforces this, but keep defensive.
                raise ValueError("item must reference a report or composite")
            if self_id is not None and item.ref_composite_id == self_id:
                raise ValueError("composite cannot include itself as an item")
            if db.get(CompositeReport, item.ref_composite_id) is None:
                raise ValueError(f"Composite not found: {item.ref_composite_id}")


def _fire_added_item_notifications(
    db: Session,
    composite: CompositeReport,
    *,
    added_refs: list[tuple[Optional[int], Optional[int]]],
    actor_user_id: int,
) -> None:
    """Fire `composite.included` / `composite.cited_upward` (Phase 5E)
    for each newly-added item. Self-notify is filtered out — adding
    your own report to your own composite doesn't need an alert.

    composite.included: ref is a Report → notify that report's owner.
    composite.cited_upward: ref is a sub-Composite → notify the sub-
    composite's owner AND each report owner inside it (their report is
    being cited one tier higher in the rollup chain)."""
    for ref_report_id, ref_composite_id in added_refs:
        if ref_report_id is not None:
            report = db.get(Report, ref_report_id)
            if (
                report is not None
                and report.owner_user_id is not None
                and report.owner_user_id != actor_user_id
            ):
                create_notification(
                    db,
                    recipient_user_id=report.owner_user_id,
                    actor_user_id=actor_user_id,
                    type=NotificationType.composite_included,
                    ref_table="composite_reports",
                    ref_id=composite.id,
                    workspace_slug=composite.workspace_slug,
                    payload={
                        "report_id": ref_report_id,
                        "report_title": report.title,
                        "composite_title": composite.title,
                    },
                )
        elif ref_composite_id is not None:
            sub = db.get(CompositeReport, ref_composite_id)
            if sub is None:
                continue
            recipients: set[int] = set()
            if (
                sub.owner_user_id is not None
                and sub.owner_user_id != actor_user_id
            ):
                recipients.add(sub.owner_user_id)
            # Walk one level — each report inside the sub-composite gets
            # cited upward too. Deep recursion (composite-of-composites-
            # of-composites) is intentionally not unrolled here; if/when
            # multi-tier rollups become a common pattern, callers can
            # opt into deeper traversal.
            for sub_item in sub.items:
                if sub_item.ref_report_id is None:
                    continue
                sub_report = db.get(Report, sub_item.ref_report_id)
                if (
                    sub_report is not None
                    and sub_report.owner_user_id is not None
                    and sub_report.owner_user_id != actor_user_id
                ):
                    recipients.add(sub_report.owner_user_id)
            for uid in recipients:
                create_notification(
                    db,
                    recipient_user_id=uid,
                    actor_user_id=actor_user_id,
                    type=NotificationType.composite_cited_upward,
                    ref_table="composite_reports",
                    ref_id=composite.id,
                    workspace_slug=composite.workspace_slug,
                    payload={
                        "composite_title": composite.title,
                        "sub_composite_id": ref_composite_id,
                        "sub_composite_title": sub.title,
                    },
                )


def _normalize_groups(groups: Optional[Iterable[str]]) -> list[str]:
    """그룹 이름 리스트 정규화 — 트림·빈값 제거·순서 보존 중복 제거. 길이는
    group_name 컬럼(128)과 맞춰 잘라낸다. None 이면 빈 리스트."""
    out: list[str] = []
    seen: set[str] = set()
    for g in groups or []:
        if not isinstance(g, str):
            continue
        name = g.strip()[:128]
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def _groups_with_item_names(
    groups: Optional[Iterable[str]],
    items: Optional[Iterable[CompositeItemPayload]],
) -> list[str]:
    """클라이언트가 보낸 그룹 골격(빈 그룹 포함)에, 안건이 참조하는
    group_name 중 빠진 것을 뒤에 보충해 일관성을 보장한다. 그룹 골격을
    안 보낸(레거시) 호출도 item group_name 으로 자동 복원된다."""
    normalized = _normalize_groups(groups)
    seen = set(normalized)
    for it in items or []:
        name = (getattr(it, "group_name", None) or "").strip()[:128]
        if name and name not in seen:
            seen.add(name)
            normalized.append(name)
    return normalized


def _replace_items(
    db: Session, composite: CompositeReport, items: list[CompositeItemPayload]
) -> None:
    # Delete the existing rows so SQLAlchemy doesn't try to merge by id;
    # composites are small enough that a full swap is the simpler model
    # and matches what "items=[…]" in the PATCH payload implies.
    for existing in list(composite.items):
        db.delete(existing)
    db.flush()
    for idx, payload in enumerate(items):
        composite.items.append(
            CompositeReportItem(
                position=idx,
                note=payload.note or "",
                ref_report_id=payload.ref_report_id,
                ref_composite_id=payload.ref_composite_id,
                display_column=payload.display_column or 1,
                group_name=payload.group_name,
            )
        )


def create(
    db: Session,
    payload: CompositeReportCreate,
    owner_user_id: int,
) -> CompositeReport:
    _validate_refs(db, payload.items)
    composite = CompositeReport(
        workspace_slug=payload.workspace_slug,
        title=payload.title,
        kind=payload.kind,
        period_date=payload.period_date,
        description=payload.description or "",
        two_col_view=payload.two_col_view,
        view_mode=payload.view_mode or "single",
        default_expanded=payload.default_expanded,
        summary_widgets=payload.summary_widgets or [],
        groups=_groups_with_item_names(payload.groups, payload.items),
        owner_user_id=owner_user_id,
        updated_by_user_id=owner_user_id,
    )
    db.add(composite)
    db.flush()  # need an id for self-reference checks + child rows
    # 자동 부서 view grant — 이 종합보고가 생성된 게시판(home)에서 보이도록
    # (공유/권한 개편: 가시성은 grant 가 단일 출처).
    grant_services.ensure_workspace_grant(
        db,
        GrantContentType.composite,
        composite.id,
        composite.workspace_slug,
        created_by_user_id=owner_user_id,
    )
    _replace_items(db, composite, payload.items)
    # Phase 5E — every initial item is "new", fire composite.included
    # (and composite.cited_upward for sub-composites). Self-notify is
    # filtered inside the helper.
    if payload.items:
        _fire_added_item_notifications(
            db,
            composite,
            added_refs=[
                (it.ref_report_id, it.ref_composite_id) for it in payload.items
            ],
            actor_user_id=owner_user_id,
        )
    db.commit()
    db.refresh(composite)
    return composite


def update(
    db: Session,
    composite: CompositeReport,
    payload: CompositeReportUpdate,
    *,
    updated_by_user_id: Optional[int] = None,
) -> CompositeReport:
    data = payload.model_dump(exclude_unset=True)
    added_refs: list[tuple[Optional[int], Optional[int]]] = []
    if "items" in data and payload.items is not None:
        # 낙관적 동시성 — 구조 전량 교체는 충돌 위험이 크므로, 클라이언트가
        # expected_revision 을 보냈고 서버 값과 다르면 거절(409). 다른 사람이
        # 그 사이에 안건을 추가/정리했다는 뜻 → 프런트가 최신본을 다시 로드.
        if (
            payload.expected_revision is not None
            and (composite.revision or 1) != payload.expected_revision
        ):
            raise CompositeConflictError(
                "다른 사용자가 먼저 저장했습니다. 최신 내용을 다시 불러오세요."
            )
        _validate_refs(db, payload.items, self_id=composite.id)
        # Capture which refs existed BEFORE the swap so we only notify
        # on truly new ones. `_replace_items` rebuilds the rows from
        # scratch so without this snapshot we'd re-notify every item on
        # every save (a note edit on item #3 would alert everyone).
        old_refs = {
            (it.ref_report_id, it.ref_composite_id) for it in composite.items
        }
        _replace_items(db, composite, payload.items)
        new_refs = {
            (it.ref_report_id, it.ref_composite_id) for it in payload.items
        }
        added_refs = list(new_refs - old_refs)
        # 구조가 바뀌었으니 동시성 토큰 증가(보기 설정만 바꾸는 PATCH 는 안 올림).
        composite.revision = (composite.revision or 1) + 1
    # 그룹 골격(빈 그룹 포함) — 보냈으면 통째로 교체. 안건이 참조하는
    # group_name 중 빠진 건 보충해 일관성 유지. items 도 함께 보낸 저장이면
    # 그 items 기준으로, 아니면 현재 저장된 items 기준으로 보충한다.
    if "groups" in data and payload.groups is not None:
        ref_items = (
            payload.items
            if ("items" in data and payload.items is not None)
            else composite.items
        )
        composite.groups = _groups_with_item_names(payload.groups, ref_items)
    for key in (
        "title",
        "kind",
        "period_date",
        "description",
        "two_col_view",
        "view_mode",
        "default_expanded",
        "summary_widgets",
    ):
        if key in data:
            setattr(composite, key, data[key])
    if updated_by_user_id is not None:
        composite.updated_by_user_id = updated_by_user_id
    if added_refs:
        _fire_added_item_notifications(
            db,
            composite,
            added_refs=added_refs,
            actor_user_id=updated_by_user_id or composite.owner_user_id or 0,
        )
    db.commit()
    db.refresh(composite)
    return composite


def delete(db: Session, composite: CompositeReport) -> None:
    # 고아 grant 방지 — content_grant 는 FK CASCADE 가 없어 수동 정리.
    grant_services.delete_all_for_content(db, GrantContentType.composite, composite.id)
    db.delete(composite)
    db.commit()


# --------------------------------------------------------------------------- #
# 안건 제출(신청) 큐 — Phase: 종합보고 동시편집 대응                            #
# --------------------------------------------------------------------------- #


def _append_report_item(
    db: Session,
    composite: CompositeReport,
    ref_report_id: int,
    *,
    note: str = "",
    actor_user_id: Optional[int] = None,
) -> bool:
    """보고서 한 건을 안건 맨 끝에 *건별 append*. 전량 교체가 아니라 한 행만
    추가하므로 다른 사람의 편집을 절대 덮어쓰지 않는다(수집 단계 충돌 회피).
    이미 안건이면 멱등하게 무시(False 반환). 추가했으면 revision 증가 후 True."""
    report = db.get(Report, ref_report_id)
    if report is None:
        raise CompositeError("제출된 보고서를 찾을 수 없습니다.")
    if any(it.ref_report_id == ref_report_id for it in composite.items):
        return False
    max_pos = max((it.position for it in composite.items), default=-1)
    composite.items.append(
        CompositeReportItem(
            position=max_pos + 1,
            note=note or "",
            ref_report_id=ref_report_id,
            display_column=1,
            group_name=None,
        )
    )
    composite.revision = (composite.revision or 1) + 1
    if actor_user_id is not None:
        composite.updated_by_user_id = actor_user_id
    db.flush()
    return True


def submit_item_request(
    db: Session,
    composite: CompositeReport,
    ref_report_id: int,
    *,
    note: str = "",
    requested_by_user_id: int,
) -> CompositeItemRequest:
    """보고서를 종합보고에 안건으로 제출(pending). 종합보고 자체는 건드리지
    않는다 — owner 승인 시에만 append 된다."""
    report = db.get(Report, ref_report_id)
    if report is None:
        raise CompositeError("보고서를 찾을 수 없습니다.")
    if any(it.ref_report_id == ref_report_id for it in composite.items):
        raise CompositeError("이미 이 종합보고의 안건입니다.")
    dup = db.execute(
        select(CompositeItemRequest).where(
            CompositeItemRequest.composite_id == composite.id,
            CompositeItemRequest.ref_report_id == ref_report_id,
            CompositeItemRequest.status == CompositeItemRequestStatus.pending,
        )
    ).scalar_one_or_none()
    if dup is not None:
        raise CompositeError("이미 제출되어 승인 대기 중입니다.")
    req = CompositeItemRequest(
        composite_id=composite.id,
        ref_report_id=ref_report_id,
        requested_by_user_id=requested_by_user_id,
        note=note or "",
        status=CompositeItemRequestStatus.pending,
    )
    db.add(req)
    db.commit()
    db.refresh(req)
    return req


def list_item_requests(
    db: Session,
    composite: CompositeReport,
    *,
    status: Optional[CompositeItemRequestStatus] = None,
) -> list[CompositeItemRequest]:
    q = select(CompositeItemRequest).where(
        CompositeItemRequest.composite_id == composite.id
    )
    if status is not None:
        q = q.where(CompositeItemRequest.status == status)
    q = q.order_by(desc(CompositeItemRequest.created_at))
    return list(db.execute(q).scalars())


def accept_item_request(
    db: Session,
    request: CompositeItemRequest,
    *,
    decided_by_user_id: int,
) -> CompositeItemRequest:
    if request.status != CompositeItemRequestStatus.pending:
        raise CompositeError("이미 처리된 제출입니다.")
    composite = db.get(CompositeReport, request.composite_id)
    if composite is None:
        raise CompositeError("종합보고를 찾을 수 없습니다.")
    if composite.published_at is not None:
        raise CompositeError(
            "발행된 종합보고입니다. 발행을 취소한 뒤 승인하세요."
        )
    _append_report_item(
        db,
        composite,
        request.ref_report_id,
        note=request.note,
        actor_user_id=decided_by_user_id,
    )
    request.status = CompositeItemRequestStatus.accepted
    request.decided_by_user_id = decided_by_user_id
    request.decided_at = datetime.utcnow()
    db.commit()
    db.refresh(request)
    return request


def reject_item_request(
    db: Session,
    request: CompositeItemRequest,
    *,
    decided_by_user_id: int,
) -> CompositeItemRequest:
    if request.status != CompositeItemRequestStatus.pending:
        raise CompositeError("이미 처리된 제출입니다.")
    request.status = CompositeItemRequestStatus.rejected
    request.decided_by_user_id = decided_by_user_id
    request.decided_at = datetime.utcnow()
    db.commit()
    db.refresh(request)
    return request


def withdraw_item_request(
    db: Session, request: CompositeItemRequest
) -> CompositeItemRequest:
    if request.status != CompositeItemRequestStatus.pending:
        raise CompositeError("이미 처리된 제출입니다.")
    request.status = CompositeItemRequestStatus.withdrawn
    request.decided_at = datetime.utcnow()
    db.commit()
    db.refresh(request)
    return request


def list_submittable_composites(
    db: Session, report: Report
) -> list[CompositeReport]:
    """이 보고서를 안건으로 제출할 수 있는 종합보고 목록. 보고서가 게시된
    게시판 + 그 조상(상위 조직)의 종합보고 — 상위 조직 종합보고가 하위팀
    보고서를 descendant 스코프로 포함하는 것과 대칭(역방향)."""
    scope: set[str] = set()
    for m in report.mounts or []:
        slug = m.workspace_slug
        if not slug or slug.startswith("personal-"):
            continue
        scope.add(slug)
        for anc in ws_services.get_ancestors(db, slug):
            scope.add(anc.slug)
    if not scope:
        return []
    q = (
        select(CompositeReport)
        .where(CompositeReport.workspace_slug.in_(scope))
        .order_by(desc(CompositeReport.updated_at))
    )
    return list(db.execute(q).scalars())


# --------------------------------------------------------------------------- #
# Publish / unpublish — Phase 5A                                              #
# --------------------------------------------------------------------------- #


def _freeze_item_snapshots(
    db: Session, composite: CompositeReport, *, now: datetime
) -> None:
    """Walk every item that references a report and copy that report's
    full content payload into `snapshot_content`. Composite-of-composite
    items (ref_composite_id) get no snapshot for now — recursion would
    be ambiguous (do you snapshot the child composite live or its own
    snapshot?). Phase 9A may revisit.
    """
    for item in composite.items:
        if item.ref_report_id is None:
            continue
        report = db.get(Report, item.ref_report_id)
        if report is None:
            # Source deleted — skip; the item is orphan-flagged on read.
            continue
        # Mirror what the report's GET endpoint sends — pages + the
        # legacy top-level template/content shape. Keep it shallow JSON
        # so future readers don't need a separate report fetch.
        item.snapshot_content = {
            "title": report.title,
            "template_id": report.template_id,
            "template_version": report.template_version,
            "content": report.content or {},
            "layout_overrides": report.layout_overrides,
            "props_overrides": report.props_overrides,
            "pages": list(report.pages or []),
            "page_width_px": report.page_width_px,
            "page_gap_px": report.page_gap_px,
            "page_blend_blocks": report.page_blend_blocks,
            "report_date": (
                report.report_date.isoformat() if report.report_date else None
            ),
        }
        item.snapshot_taken_at = now


def _clear_item_snapshots(composite: CompositeReport) -> None:
    for item in composite.items:
        item.snapshot_content = None
        item.snapshot_taken_at = None


def publish(
    db: Session,
    composite: CompositeReport,
    *,
    actor_user_id: int,
) -> CompositeReport:
    """Mark a composite as published. For kind=recurring, freezes the
    current content of each item's referenced report into
    `snapshot_content`. theme composites also accept the publish call
    but treat it as a no-op snapshot-wise (they're always live by
    design); `published_at` still gets stamped so the UI can show "발행
    됨" if the team wants that signal.

    Idempotent: already-published returns the same composite untouched.
    Owner-only — caller must enforce upstream (route layer).

    Phase 5E — fires `composite.published` to the owner when someone
    other than the owner published (e.g. system admin force-publish).
    Self-publish is silent (the actor already knows they published).
    """
    if composite.published_at is not None:
        return composite
    now = datetime.utcnow()
    if composite.kind == CompositeKind.recurring:
        _freeze_item_snapshots(db, composite, now=now)
    composite.published_at = now
    composite.published_by_user_id = actor_user_id
    if (
        composite.owner_user_id is not None
        and composite.owner_user_id != actor_user_id
    ):
        create_notification(
            db,
            recipient_user_id=composite.owner_user_id,
            actor_user_id=actor_user_id,
            type=NotificationType.composite_published,
            ref_table="composite_reports",
            ref_id=composite.id,
            workspace_slug=composite.workspace_slug,
            payload={"composite_title": composite.title},
        )
    db.commit()
    db.refresh(composite)
    return composite


def unpublish(
    db: Session,
    composite: CompositeReport,
    *,
    actor_user_id: int,
) -> CompositeReport:
    """Reverse `publish`. Clears `published_at` + per-item snapshots so
    the composite goes back to live-fetch mode and is editable as a
    draft again. Idempotent for already-unpublished composites.
    """
    if composite.published_at is None:
        return composite
    if composite.kind == CompositeKind.recurring:
        _clear_item_snapshots(composite)
    composite.published_at = None
    composite.published_by_user_id = None
    db.commit()
    db.refresh(composite)
    return composite
