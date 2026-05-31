"""Report routes — CRUD scoped to the actor's workspace tree."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.reports import services
from app.modules.reports.schemas import (
    LinkGraphResponse,
    LockInfo,
    ReportCreate,
    ReportLinkCreate,
    ReportLinkKindRead,
    ReportLinkRead,
    ReportLinkRefMini,
    ReportRead,
    ReportSummary,
    ReportUpdate,
)
from app.shared.auth import CurrentUser, get_current_user, require_writer
from app.shared.responses import (
    created_response,
    error_response,
    not_found_response,
    success_response,
)

router = APIRouter()


def _read_with_perms(db: Session, actor: CurrentUser, report) -> ReportRead:
    """Build a ReportRead and stamp the per-actor edit decision.

    Used by detail/update/publish/unpublish/lock returns so the frontend
    can disable edit affordances without re-implementing the rule.
    List endpoints skip this — per-row resolution is too expensive and
    the list page falls back to optimistic show + 403 on save."""
    from app.shared.permissions import can_edit

    obj = ReportRead.model_validate(report)
    decision = can_edit(db, actor.user, report)
    obj.can_edit = decision.allowed
    obj.edit_role = decision.role
    # 조직 간 공개(§6) — 외부 공개 열람자면 읽기전용 플래그를 세워 프런트가
    # 배너·곁다리 숨김을 그린다. virtual(글로벌/관리자)은 공개 열람자가 아님.
    is_public_view = (
        not actor.workspace.virtual
        and services.is_public_only_viewer(db, report, actor.workspace.slug)
    )
    obj.is_public_view = is_public_view
    obj.can_comment = not is_public_view
    return obj


def _lock_conflict_response(exc: services.LockError):
    """Translate a service-layer LockError into a 409 in the standard
    {success, message, errors} envelope. `errors[0]` carries a stable
    `code` string the frontend dispatches on; `holder` (when known) lets
    the takeover dialog render '현재 OO 편집 중' without a re-fetch.
    """
    detail: dict = {"code": exc.code, "message": str(exc)}
    if exc.holder is not None:
        detail["holder"] = LockInfo.model_validate({
            "user_id": exc.holder.user_id,
            "user_name": getattr(exc.holder.user, "name", None),
            "user_email": getattr(exc.holder.user, "email", None),
            "acquired_at": exc.holder.acquired_at,
            "expires_at": exc.holder.expires_at,
        }).model_dump(mode="json")
    return error_response(str(exc), errors=[detail], status_code=409)


@router.get("")
def list_reports(
    entity_ids: list[int] | None = Query(default=None, alias="entity_ids"),
    folder_id: str | None = Query(
        default=None,
        description=(
            "Personal-space folder filter. Pass an integer id to show "
            "only that folder's reports, or 'uncategorized' for "
            "folder_id IS NULL. Ignored on org workspaces."
        ),
    ),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """List reports in the actor's workspace tree.

    Optional `entity_ids` (repeated) applies the N-axis tag filter:
    OR within an axis, AND across axes. Sent by the list-page filter
    bar; absent for the default unfiltered view.

    `folder_id` is meaningful only in personal-workspace context; the
    backend currently ignores it on org workspaces because folders are
    a per-user concept (Phase 4 may extend cross-workspace folders).
    """
    # Translate the folder filter — string-typed at the API edge so we
    # can carry the special "uncategorized" sentinel without overloading
    # integer semantics. Defensive: silently drop garbage.
    folder_filter: int | str | None = None
    if folder_id == "uncategorized":
        folder_filter = "uncategorized"
    elif folder_id is not None:
        try:
            folder_filter = int(folder_id)
        except ValueError:
            folder_filter = None
    reports = services.list_reports_in_workspace(
        db,
        actor.workspace.slug,
        is_global_view=actor.workspace.virtual,
        entity_ids=entity_ids,
        folder_filter=folder_filter,
    )
    payload = [ReportSummary.model_validate(r) for r in reports]
    return success_response(data=payload)


# /{report_id} 동적 path 보다 *위* 에 등록해야 한다 — 그래야 FastAPI 가
# `link-kinds` 문자열을 reportId 로 잡으려고 시도(422)하지 않고 이 정적
# path 와 먼저 매칭한다.
@router.get("/link-kinds")
def list_link_kinds_public(
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(get_current_user),
):
    """모든 인증 사용자가 picker / chip 렌더에 쓰는 카탈로그. admin 만
    편집 가능하지만 조회는 공개."""
    rows = services.list_link_kinds(db)
    return success_response(
        data=[ReportLinkKindRead.model_validate(r) for r in rows]
    )


@router.get("/linkable-facets")
def get_linkable_facets(
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Link 대상 picker 의 작성자 / 게시조직 필터 옵션. 한 번에 두 facet
    을 반환해 picker 의 popover open 비용을 가볍게 만든다.

    응답:
        {
          "authors": [{"name": "김XX", "count": 12}, ...],
          "mounts":  [{"slug": "team1", "name": "팀1", "count": 5}, ...]
        }
    """
    return success_response(data=services.list_linkable_facets(db, actor))


@router.get("/linkable")
def list_linkable_reports_route(
    db: Session = Depends(get_db),
    _: CurrentUser = Depends(get_current_user),
):
    """Link 대상 picker 의 후보 보고서 풀 — 전 시스템 linkable.
    actor 워크스페이스 밖 보고서도 검색할 수 있어야 하므로 list_reports
    와 별도 endpoint. ReportSummary 와 동일한 shape."""
    reports = services.list_linkable_reports(db)
    payload = [ReportSummary.model_validate(r) for r in reports]
    return success_response(data=payload)


@router.get("/link-graph")
def get_global_link_graph(
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    types: list[int] | None = Query(default=None),
    kinds: list[str] | None = Query(default=None),
    entities: list[int] | None = Query(default=None),
    include_tags: bool = Query(default=False),
    tag_axes: list[str] | None = Query(default=None),
    tag_min_degree: int = Query(default=1, ge=1, le=20),
    include_composites: bool = Query(default=False),
    include_isolated: bool = Query(default=False),
    limit: int = Query(default=services.LINK_GRAPH_GLOBAL_LIMIT, ge=1, le=2000),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """워크스페이스 범위의 글로벌 관계도 (지식그래프 Phase 1b).

    `/{report_id}` 동적 path 보다 위에 등록 — `link-graph` 문자열이 reportId
    로 잡히지 않도록. 스코핑은 actor.workspace (virtual 이면 전체). 연결된
    보고서만 그린다 (고립 노드 제외)."""
    from datetime import date as _date

    def _parse(d: str | None) -> _date | None:
        if not d:
            return None
        try:
            return _date.fromisoformat(d)
        except ValueError:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Invalid date: {d}"
            )

    graph = services.build_global_link_graph(
        db,
        workspace_slug=actor.workspace.slug,
        is_global_view=actor.workspace.virtual,
        date_from=_parse(date_from),
        date_to=_parse(date_to),
        type_ids=types,
        kinds=kinds,
        entity_ids=entities,
        include_tags=include_tags,
        tag_axes=tag_axes,
        tag_min_degree=tag_min_degree,
        include_composites=include_composites,
        include_isolated=include_isolated,
        limit=limit,
    )
    return success_response(data=LinkGraphResponse.model_validate(graph))


@router.get("/{report_id}")
def get_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not actor.workspace.virtual and not services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    return success_response(data=_read_with_perms(db, actor, report))


@router.post("")
def create_report(
    payload: ReportCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    if actor.workspace.virtual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Cannot create report in a virtual workspace; switch to a real workspace.",
        )
    # Phase 1: every new report is born in the creator's personal
    # workspace, regardless of which workspace they're currently
    # browsing. Promotion to org boards is a deliberate "게시" action
    # afterwards. This is the structural enforcement of the "개인
    # 작업공간과 조직 게시판 분리" decision (협업개선_설계.md §2).
    target_workspace = f"personal-{actor.user.id}"
    try:
        report = services.create_report(
            db, target_workspace, payload, owner_user_id=actor.user.id
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=_read_with_perms(db, actor, report))


@router.put("/{report_id}/author-lock")
def set_author_lock(
    report_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Toggle the author lock. Body: {enabled: bool, reason?: str}.

    Permission: report owner OR system admin (force unset). System
    admins can override the lock to unblock a stuck workflow when the
    author is unavailable — that path emits a separate
    `report.lock_force_unset` notification to the owner so they know.
    """
    from datetime import datetime as _dt
    from app.modules.activities.models import ReportActivityType
    from app.modules.activities.services import record_activity
    from app.modules.notifications.models import NotificationType
    from app.modules.notifications.services import create_notification
    from app.modules.mounts.models import ReportMount
    from app.modules.users.models import WorkspaceMember, Role
    from sqlalchemy import select

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")

    enabled = bool(payload.get("enabled"))
    reason = (payload.get("reason") or "").strip()
    is_owner = report.owner_user_id == actor.user.id
    is_system_admin = actor.user.is_system_admin
    is_force_unset = (not enabled) and not is_owner and is_system_admin

    if not is_owner and not is_force_unset:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "작성자만 잠금/해제 가능합니다 (또는 시스템 관리자의 강제 해제).",
        )

    report.author_lock_enabled = enabled
    if enabled:
        report.author_lock_reason = reason
        report.author_lock_set_at = _dt.utcnow()
    else:
        report.author_lock_reason = ""
        report.author_lock_set_at = None

    record_activity(
        db,
        report_id=report.id,
        type=(
            ReportActivityType.lock_force_unset if is_force_unset
            else ReportActivityType.locked if enabled
            else ReportActivityType.unlocked
        ),
        actor_user_id=actor.user.id,
        payload={"reason": reason} if enabled else {},
    )

    # Notify on lock — every board lead the report is mounted to should
    # know so they don't try editing and hit a wall.
    if enabled:
        mount_slugs = list(
            db.execute(
                select(ReportMount.workspace_slug).where(
                    ReportMount.report_id == report.id
                )
            ).scalars()
        )
        notified: set[int] = set()
        for slug in mount_slugs:
            leads = db.execute(
                select(WorkspaceMember.user_id).where(
                    WorkspaceMember.workspace_slug == slug,
                    WorkspaceMember.role == Role.manager,
                )
            ).scalars()
            for uid in leads:
                if uid in notified or uid == actor.user.id:
                    continue
                notified.add(uid)
                create_notification(
                    db,
                    recipient_user_id=uid,
                    actor_user_id=actor.user.id,
                    type=NotificationType.report_locked,
                    ref_table="reports",
                    ref_id=report.id,
                    workspace_slug=slug,
                    payload={
                        "report_title": report.title,
                        "reason": reason,
                    },
                )
    # Force-unset path notifies the owner about the override.
    if is_force_unset and report.owner_user_id is not None:
        create_notification(
            db,
            recipient_user_id=report.owner_user_id,
            actor_user_id=actor.user.id,
            type=NotificationType.report_lock_force_unset,
            ref_table="reports",
            ref_id=report.id,
            payload={"report_title": report.title},
        )

    db.commit()
    db.refresh(report)
    return success_response(data=_read_with_perms(db, actor, report))


@router.post("/{report_id}/publish")
def publish_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Owner-only: bump phase → finalized. Editing is gated downstream
    based on phase (finalized = read-only at the frontend layer; the
    backend update path will reject in Phase 2C alongside author lock).

    Recording: activity row + notification to mounted-board members are
    fired here. Idempotent — already-finalized just returns the current
    state.
    """
    from app.modules.activities.models import ReportActivityType
    from app.modules.activities.services import record_activity
    from app.modules.notifications.models import NotificationType
    from app.modules.notifications.services import create_notification
    from app.modules.reports.models import ReportPhase
    from app.modules.mounts.models import ReportMount
    from app.modules.users.models import WorkspaceMember
    from sqlalchemy import select

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if report.owner_user_id != actor.user.id and not actor.user.is_system_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "발행은 작성자만 가능합니다."
        )
    if report.phase == ReportPhase.finalized:
        return success_response(data=_read_with_perms(db, actor, report))

    previous = report.phase
    report.phase = ReportPhase.finalized
    record_activity(
        db,
        report_id=report.id,
        type=ReportActivityType.phase_to_finalized,
        actor_user_id=actor.user.id,
        payload={"previous_phase": previous.value},
    )
    # Notify all members of every workspace this report is mounted to.
    mount_slugs = [
        m for m in db.execute(
            select(ReportMount.workspace_slug).where(
                ReportMount.report_id == report.id
            )
        ).scalars()
    ]
    notified: set[int] = set()
    for slug in mount_slugs:
        members = db.execute(
            select(WorkspaceMember.user_id).where(
                WorkspaceMember.workspace_slug == slug
            )
        ).scalars()
        for uid in members:
            if uid in notified or uid == actor.user.id:
                continue
            notified.add(uid)
            create_notification(
                db,
                recipient_user_id=uid,
                actor_user_id=actor.user.id,
                type=NotificationType.report_phase_to_finalized,
                ref_table="reports",
                ref_id=report.id,
                workspace_slug=slug,
                payload={"report_title": report.title},
            )
    db.commit()
    db.refresh(report)
    return success_response(data=_read_with_perms(db, actor, report))


@router.post("/{report_id}/unpublish")
def unpublish_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Owner-only: finalized → drafting. Lets the owner make changes
    after publishing. (Sets to drafting, not reviewing — re-publishing
    is a deliberate re-trigger.)
    """
    from app.modules.activities.models import ReportActivityType
    from app.modules.activities.services import record_activity
    from app.modules.reports.models import ReportPhase

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if report.owner_user_id != actor.user.id and not actor.user.is_system_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "발행 취소는 작성자만 가능합니다."
        )
    if report.phase != ReportPhase.finalized:
        return success_response(data=_read_with_perms(db, actor, report))

    report.phase = ReportPhase.drafting
    record_activity(
        db,
        report_id=report.id,
        type=ReportActivityType.phase_to_drafting,
        actor_user_id=actor.user.id,
        payload={"trigger": "unpublish"},
    )
    db.commit()
    db.refresh(report)
    return success_response(data=_read_with_perms(db, actor, report))


@router.put("/{report_id}/folder")
def move_report_to_folder(
    report_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Metadata-only assignment of a report to a personal folder.

    Separate from the main PATCH /reports/{id} because (a) it doesn't
    touch content/structure (no lock needed), (b) only the report owner
    can move their own report (folders are per-user), and (c) the UI
    needs a one-shot endpoint that doesn't require the optimistic
    revision dance — folder placement is independent of content
    revisions.

    Body: { "folder_id": int | null }  (null = uncategorized)
    """
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if report.owner_user_id != actor.user.id and not actor.user.is_system_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "본인 보고서만 폴더 이동할 수 있습니다.",
        )
    folder_id = payload.get("folder_id")
    if folder_id is not None and not isinstance(folder_id, int):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "folder_id must be int or null"
        )
    # If a folder id is given, sanity-check it belongs to the report's
    # owner (not just the actor — for sys admin moving another user's
    # report). Without this, forging a folder id could park a report
    # under someone else's folder.
    if folder_id is not None:
        from app.modules.folders.models import Folder

        folder = db.get(Folder, folder_id)
        expected_owner = report.owner_user_id
        if folder is None or folder.user_id != expected_owner:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"폴더를 찾을 수 없거나 권한이 없습니다: {folder_id}",
            )
    report.folder_id = folder_id
    db.commit()
    db.refresh(report)
    return success_response(data=_read_with_perms(db, actor, report))


@router.patch("/{report_id}")
def update_report(
    report_id: int,
    payload: ReportUpdate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    from app.shared.permissions import can_edit

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not actor.workspace.virtual and not services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    # Phase 3 — single can_edit() check. Subsumes the Phase 2 hard-lock
    # veto (decision_role='locked') and adds boss/coauthor/editor paths.
    decision = can_edit(db, actor.user, report)
    if not decision.allowed:
        if decision.role == "locked":
            reason = report.author_lock_reason or "사유 미기재"
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"작성자가 수정 잠금 상태입니다 (사유: {reason}). 잠금 해제 후 다시 시도하세요.",
            )
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 보고서를 편집할 권한이 없습니다.",
        )
    # Phase 2B — finalized reports are read-only. Author must unpublish
    # (POST /reports/{id}/unpublish) to make changes.
    from app.modules.reports.models import ReportPhase

    if report.phase == ReportPhase.finalized:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "발행된 보고서는 편집할 수 없습니다. '발행 취소' 후 수정하세요.",
        )
    try:
        report = services.update_report(
            db,
            report,
            payload,
            updated_by_user_id=actor.user.id,
            expected_revision=payload.expected_revision,
        )
    except services.LockError as exc:
        return _lock_conflict_response(exc)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    # Phase 3 — notify owner when a non-owner edits. Decision #4: no
    # debounce. Activity log already has the full sequence; the inbox
    # just gets one row per save (user can mass-clear).
    if (
        report.owner_user_id is not None
        and report.owner_user_id != actor.user.id
    ):
        from app.modules.notifications.models import NotificationType
        from app.modules.notifications.services import create_notification

        create_notification(
            db,
            recipient_user_id=report.owner_user_id,
            actor_user_id=actor.user.id,
            type=NotificationType.report_edited_by_other,
            ref_table="reports",
            ref_id=report.id,
            payload={
                "report_title": report.title,
                "editor_role": decision.role,
            },
        )
        db.commit()

    return success_response(data=_read_with_perms(db, actor, report))


# --------------------------------------------------------------------------- #
# Edit lock endpoints                                                         #
# --------------------------------------------------------------------------- #


def _resolve_writable_report(
    db: Session, report_id: int, actor: CurrentUser
):
    """Shared guard for the three lock endpoints. Returns the report or
    raises the standard 404/403. Kept inline (not a Depends) because all
    three handlers need to surface the report object itself."""
    report = services.get_report(db, report_id)
    if not report:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"Report not found: {report_id}"
        )
    if not actor.workspace.virtual and not services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    return report


@router.post("/{report_id}/lock")
def acquire_lock(
    report_id: int,
    force: bool = Query(default=False),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Claim or refresh the edit lock. Pass `?force=true` to override an
    existing live lock (the previous holder will fail their next heartbeat
    / save and be bounced back to view mode)."""
    report = _resolve_writable_report(db, report_id, actor)
    try:
        lock = services.acquire_lock(db, report, actor.user.id, force=force)
    except services.LockError as exc:
        return _lock_conflict_response(exc)
    db.commit()
    db.refresh(report)
    info = LockInfo.model_validate({
        "user_id": lock.user_id,
        "user_name": actor.user.name,
        "user_email": actor.user.email,
        "acquired_at": lock.acquired_at,
        "expires_at": lock.expires_at,
    })
    return success_response(data=info)


@router.post("/{report_id}/lock/heartbeat")
def heartbeat_lock(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Extend the caller's lock TTL. Returns 409 if the caller doesn't hold
    a live lock — the frontend treats that as "you got bumped" and exits
    edit mode."""
    report = _resolve_writable_report(db, report_id, actor)
    try:
        lock = services.heartbeat_lock(db, report, actor.user.id)
    except services.LockError as exc:
        return _lock_conflict_response(exc)
    db.commit()
    info = LockInfo.model_validate({
        "user_id": lock.user_id,
        "user_name": actor.user.name,
        "user_email": actor.user.email,
        "acquired_at": lock.acquired_at,
        "expires_at": lock.expires_at,
    })
    return success_response(data=info)


@router.delete("/{report_id}/lock")
def release_lock(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """Drop the lock. Idempotent — releases for non-holders or already-
    expired locks return 200 with a no-op so the frontend can fire-and-
    forget from beforeunload handlers."""
    report = _resolve_writable_report(db, report_id, actor)
    services.release_lock(db, report, actor.user.id)
    db.commit()
    return success_response(data=None, message="Released")


@router.delete("/{report_id}")
def delete_report(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not actor.workspace.virtual and not services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    services.delete_report(db, report)
    return success_response(data=None, message="Deleted")


# ─── Report links ────────────────────────────────────────────────────────── #


def _link_to_read(report_id: int, link) -> ReportLinkRead:
    """ORM ReportLink → ReportLinkRead. direction 은 link 가 이 보고서의
    outgoing 인지 incoming 인지로 결정. counterpart 도 그쪽으로 set."""
    if link.from_report_id == report_id:
        direction = "outgoing"
        cp = link.to_report
    else:
        direction = "incoming"
        cp = link.from_report
    return ReportLinkRead(
        id=link.id,
        kind=link.kind,
        note=link.note,
        direction=direction,
        counterpart=ReportLinkRefMini(
            id=cp.id,
            workspace_slug=cp.workspace_slug,
            title=cp.title,
            owner_name=getattr(cp.owner, "name", None) if cp.owner else None,
            report_date=cp.report_date,
        ),
        created_at=link.created_at,
        created_by_name=(
            getattr(link.created_by, "name", None) if link.created_by else None
        ),
    )


@router.get("/{report_id}/links")
def get_report_links(
    report_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """이 보고서의 양방향 link 목록. 권한은 보고서 read 와 동일."""
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not actor.workspace.virtual and not services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    links = services.list_links_for_report(db, report_id)
    # 가시성 가드 제거 — picker 가 시스템 전체 linkable 풀에서 후보를
    # 보여주므로 (POST 도 같은 정책) link 자체도 동일하게 노출.
    payload = [_link_to_read(report_id, lk) for lk in links]
    return success_response(data=payload)


@router.get("/{report_id}/link-graph")
def get_report_link_graph(
    report_id: int,
    depth: int = Query(default=2, ge=1, le=3),
    include_tags: bool = Query(default=False),
    tag_axes: list[str] | None = Query(default=None),
    tag_min_degree: int = Query(default=1, ge=1, le=20),
    include_composites: bool = Query(default=False),
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """이 보고서를 중심으로 한 ±depth hop 관계도 (지식그래프 Phase 1a).

    권한은 보고서 read 와 동일 — 중심 보고서가 보이면 그래프도 본다.
    이웃 노드의 가시성은 별도로 가드하지 않는다 (link 자체가 이미 시스템
    전체 linkable 정책으로 노출되는 것과 일관, links GET 과 같은 정책)."""
    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not actor.workspace.virtual and not services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    graph = services.build_link_graph(
        db,
        report_id,
        depth=depth,
        include_tags=include_tags,
        tag_axes=tag_axes,
        tag_min_degree=tag_min_degree,
        include_composites=include_composites,
    )
    if graph is None:
        return not_found_response(f"Report not found: {report_id}")
    return success_response(data=LinkGraphResponse.model_validate(graph))


@router.post("/{report_id}/links")
def create_report_link(
    report_id: int,
    payload: ReportLinkCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """현재 보고서(path) 와 payload.to_report_id 사이 link 생성.
    direction 에 따라 단방향 저장 방향이 결정 — outgoing 이면
    path→target, incoming 이면 target→path. 권한 검사는 *path 보고서* 만."""
    from app.shared.permissions import can_edit

    report = services.get_report(db, report_id)
    if not report:
        return not_found_response(f"Report not found: {report_id}")
    if not actor.workspace.virtual and not services.is_visible_to(
        db, report, actor.workspace.slug
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Out of workspace scope")
    decision = can_edit(db, actor.user, report)
    if not decision.allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 보고서를 편집할 권한이 없어 link 를 추가할 수 없습니다.",
        )
    target = services.get_report(db, payload.to_report_id)
    if not target:
        return not_found_response(
            f"Target report not found: {payload.to_report_id}"
        )
    # 가시성 가드는 target 쪽엔 적용하지 않는다 — picker 가 시스템 전체
    # linkable 풀에서 후보를 보여주는 정책과 일관. 적격성 (is_linkable_target)
    # 통과만 받으면 단일-테넌트 안 어떤 조직 보고서라도 link 가능.
    if not services.is_linkable_target(db, target):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "이 보고서는 link 대상으로 부적합합니다 — 조직 게시판에 게시되지 않은 개인 보고서입니다.",
        )
    # direction 에 따라 from/to 결정. 데이터는 항상 단방향 한 row.
    if payload.direction == "incoming":
        from_id = payload.to_report_id
        to_id = report_id
    else:
        from_id = report_id
        to_id = payload.to_report_id
    try:
        link = services.create_link(
            db,
            from_report_id=from_id,
            to_report_id=to_id,
            kind=payload.kind,
            note=payload.note,
            created_by_user_id=actor.user.id,
        )
    except services.LinkError as exc:
        return error_response(
            str(exc),
            errors=[{"code": exc.code, "message": str(exc)}],
            status_code=400 if exc.code != "duplicate" else 409,
        )
    return created_response(data=_link_to_read(report_id, link))


@router.delete("/{report_id}/links/{link_id}")
def delete_report_link(
    report_id: int,
    link_id: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_writer),
):
    """삭제 권한: path 의 보고서 쪽 can_edit 면 OK — link 의 from 이든
    to 든 자기 보고서에서 보이는 link 라면 자기 손으로 정리 가능."""
    from app.shared.permissions import can_edit

    link = services.get_link(db, link_id)
    if link is None:
        return not_found_response(f"Link not found: {link_id}")
    if link.from_report_id != report_id and link.to_report_id != report_id:
        return not_found_response("이 보고서의 link 가 아닙니다.")
    report = services.get_report(db, report_id)
    if report is None:
        return not_found_response(f"Report not found: {report_id}")
    decision = can_edit(db, actor.user, report)
    if not decision.allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 보고서를 편집할 권한이 없어 link 를 끊을 수 없습니다.",
        )
    services.delete_link(db, link)
    return success_response(data=None, message="Deleted")
