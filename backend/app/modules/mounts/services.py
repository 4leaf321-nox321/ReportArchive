"""Mount service layer — promote/demote reports across org boards.

The two key actions:

  * `mount_report(report_id, workspace_slugs, by_user)` — create
    ReportMount rows for one or more org boards. Side-effects:
      - emits `mount.new_to_me` to the report owner (if mounter != owner)
      - emits `mount.new_in_board` to each board's members
      - bumps the report's phase drafting → reviewing if this is the
        first time the report became publicly visible (any mount exists)

  * `unmount_report(report_id, workspace_slug, by_user)` — delete one
    ReportMount row. Removes visibility from that board. Idempotent
    (no error if the mount is already gone). Does NOT touch phase —
    going back to all-personal is treated as an editorial decision,
    not a regression of the review state.

Permission gates live here, not in the route layer, so the same checks
apply to service-internal callers (e.g. a future "auto-mount via
composite include" flow).
"""
from __future__ import annotations

from datetime import datetime
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.folders.models import Folder, FolderKind
from app.modules.grants import services as grant_services
from app.modules.grants.models import (
    GrantContentType,
    GrantLevel,
    GrantPrincipalType,
)
from app.modules.mounts.models import (
    MountEditPolicy,
    ReportMount,
    ReportTakedownRequest,
    TakedownStatus,
)
from app.modules.notifications.models import NotificationType
from app.modules.notifications.services import create_notification
from app.modules.reports.models import Report, ReportPhase
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace, WorkspaceKind


class MountError(Exception):
    """Base class so the route layer can translate to 4xx easily."""

    code = "mount_error"
    status_code = 400


class MountForbiddenError(MountError):
    code = "mount_forbidden"
    status_code = 403


class MountTargetInvalidError(MountError):
    code = "mount_target_invalid"
    status_code = 400


def _role_on_workspace(
    db: Session, user_id: int, workspace_slug: str
) -> Optional[Role]:
    """user 가 workspace 에서 갖는 역할(조상 멤버십 상속). 멤버십이 없으면 None.
    auth._resolve_role 과 같은 ancestor-walk 의미."""
    visited: set[str] = set()
    cur: Optional[str] = workspace_slug
    while cur and cur not in visited:
        visited.add(cur)
        m = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.user_id == user_id,
                WorkspaceMember.workspace_slug == cur,
            )
        ).scalar_one_or_none()
        if m is not None:
            return m.role
        anc = db.get(Workspace, cur)
        if anc is None:
            break
        cur = anc.parent_slug
    return None


def _ensure_can_mount(
    db: Session, report: Report, actor_user_id: int
) -> None:
    """게시(mount) 권한:

      1) **작성자 본인**은 항상 게시 가능.
      2) **이미 게시된 게시판의 매니저**는 그 문서를 다른 게시판에도 게시
         가능 — "A 게시판에 올라간 문서를 A 매니저가 B 게시판으로 확산"
         (협업개선 설계의 Phase 3 흐름). 게시판은 조상 상속을 따르므로 상위
         부서 매니저도 포함된다. 단 대상 게시판 접근권은 별도로
         _ensure_target_is_org_workspace 가 확인한다(자기가 속한 게시판에만
         게시 가능 — 임의 게시판에 밀어넣기 방지).

    소유자도 아니고 게시된 어느 게시판의 매니저도 아니면 거절.
    """
    if report.owner_user_id is not None and report.owner_user_id == actor_user_id:
        return
    # 이미 게시된 게시판 중 actor 가 매니저인 곳이 하나라도 있으면 허용.
    for m in list_mounts_for_report(db, report.id):
        if _role_on_workspace(db, actor_user_id, m.workspace_slug) == Role.manager:
            return
    if report.owner_user_id is None:
        # Orphan reports + 매니저도 아님 — admin-only flow 는 별도(미구현).
        raise MountForbiddenError(
            "owner가 없는 보고서는 현재 게시할 수 없습니다 (관리자 도구 필요)."
        )
    raise MountForbiddenError(
        "본인이 작성했거나 이미 게시된 게시판의 매니저인 보고서만 "
        "다른 게시판에 게시할 수 있습니다."
    )


def _ensure_target_is_org_workspace(
    db: Session, workspace_slug: str, actor_user_id: int
) -> Workspace:
    """The target board must (a) exist, (b) be an org workspace —
    mounting to personal/virtual is meaningless — and (c) be one the
    actor has access to.

    Access has two paths:
      1) **멤버십** — walk up the parent chain from the target and accept
         any membership found (mirrors auth `_resolve_role`). A user with
         membership at a parent (e.g. 본부) can publish to any descendant
         team without separate memberships.
      2) **게시판 편집 권한 개방(board edit grant)** — 그 게시판 매니저가
         다른 부서/사용자에게 edit 권한을 열어두면(`/workspaces/{slug}/shares`),
         그 부서 소속(또는 직접 grant 받은 사용자)도 게시할 수 있다. 멤버가
         아니어도 "편집 권한이 열린 게시판"이면 게시 대상이 된다.
    """
    ws = db.get(Workspace, workspace_slug)
    if ws is None:
        raise MountTargetInvalidError(
            f"게시 대상 워크스페이스를 찾을 수 없습니다: {workspace_slug}"
        )
    if ws.kind != WorkspaceKind.org:
        raise MountTargetInvalidError(
            f"조직 워크스페이스에만 게시할 수 있습니다 (kind={ws.kind.value})."
        )
    # 1) Ancestor walk — mirror _resolve_role(auth.py).
    visited: set[str] = set()
    cur: Optional[str] = workspace_slug
    while cur and cur not in visited:
        visited.add(cur)
        m = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.user_id == actor_user_id,
                WorkspaceMember.workspace_slug == cur,
            )
        ).scalar_one_or_none()
        if m is not None:
            return ws
        anc = db.get(Workspace, cur)
        if anc is None:
            break
        cur = anc.parent_slug
    # 2) 편집 권한이 개방된 게시판이면 멤버가 아니어도 게시 허용.
    if grant_services._board_edit_reaches(db, [workspace_slug], actor_user_id):
        return ws
    raise MountForbiddenError(
        f"접근 권한이 없는 워크스페이스에는 게시할 수 없습니다: {workspace_slug}"
    )


def _sync_mount_grants(
    db: Session,
    report_id: int,
    slug: str,
    policy: MountEditPolicy,
    actor_user_id: int,
) -> None:
    """게시 편집 정책 → grant 상태 동기화(편집은 grant 단일 출처).

      default/owner_only → 부서 view (작성자만 편집)
      coauthor           → 부서 edit (게시판 멤버 누구나 편집)
      manager            → 부서 view + workspace_manager edit (작성자+매니저)
    """
    upsert = grant_services.upsert_grant
    remove = grant_services.remove_principal_grant
    R = GrantContentType.report
    WS = GrantPrincipalType.workspace
    WM = GrantPrincipalType.workspace_manager

    if policy == MountEditPolicy.coauthor:
        upsert(db, R, report_id, WS, slug, GrantLevel.edit, created_by_user_id=actor_user_id)
        remove(db, R, report_id, WM, slug)
    elif policy == MountEditPolicy.manager:
        upsert(db, R, report_id, WS, slug, GrantLevel.view, created_by_user_id=actor_user_id)
        upsert(db, R, report_id, WM, slug, GrantLevel.edit, created_by_user_id=actor_user_id)
    else:  # default / owner_only
        upsert(db, R, report_id, WS, slug, GrantLevel.view, created_by_user_id=actor_user_id)
        remove(db, R, report_id, WM, slug)


def _board_lead_user_id(db: Session, workspace_slug: str) -> Optional[int]:
    """Returns the user_id with the highest role on this workspace
    (admin > manager > user). Used for 'mount.new_in_board' targeting.

    For Phase 1 we only notify a single board lead per mount to keep
    inboxes quiet; broadcasting to every board member can land later
    behind a per-workspace notification policy.
    """
    rows = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_slug == workspace_slug
        )
    ).scalars().all()
    if not rows:
        return None
    # 매니저가 사용자보다 우선. p8 이전엔 admin/manager/user 3단계였지만
    # 이제 manager/user 두 단계라 두 키만 필요.
    priority = {Role.manager: 0, Role.user: 1}
    rows.sort(key=lambda m: priority.get(m.role, 99))
    return rows[0].user_id


def list_mounts_for_report(db: Session, report_id: int) -> list[ReportMount]:
    return list(
        db.execute(
            select(ReportMount)
            .where(ReportMount.report_id == report_id)
            .order_by(ReportMount.mounted_at)
        ).scalars()
    )


def _validate_folder_for_workspace(
    db: Session, folder_id: int, workspace_slug: str
) -> None:
    """Ensure the folder id is an org folder of the right workspace.
    Personal folders or other-workspace folders aren't a valid mount
    placement target."""
    folder = db.get(Folder, folder_id)
    if folder is None:
        raise MountTargetInvalidError(f"폴더를 찾을 수 없습니다: {folder_id}")
    if folder.kind != FolderKind.org or folder.workspace_slug != workspace_slug:
        raise MountTargetInvalidError(
            f"{workspace_slug} 게시판의 폴더만 선택할 수 있습니다."
        )


def mount_report(
    db: Session,
    *,
    report_id: int,
    workspace_slugs: Iterable[str],
    actor_user_id: int,
    edit_policy: MountEditPolicy = MountEditPolicy.default,
    note: str = "",
    folder_id: Optional[int] = None,
) -> list[ReportMount]:
    """Promote a report to one or more org boards. Idempotent per-board
    (an existing mount stays and its edit_policy/note are NOT updated
    — use a dedicated PATCH endpoint for that in Phase 3).

    Returns only newly-created mount rows. Notifications are emitted
    for new rows only — re-mounting an already-mounted report does not
    re-notify.
    """
    report = db.get(Report, report_id)
    if report is None:
        raise MountTargetInvalidError(f"보고서를 찾을 수 없습니다: {report_id}")
    _ensure_can_mount(db, report, actor_user_id)

    # Pre-load existing mounts so the dedupe is one query, not N.
    existing = {
        m.workspace_slug: m
        for m in db.execute(
            select(ReportMount).where(ReportMount.report_id == report_id)
        ).scalars()
    }
    had_any_mount_before = len(existing) > 0

    created: list[ReportMount] = []
    for slug in workspace_slugs:
        if slug in existing:
            continue  # idempotent skip
        _ensure_target_is_org_workspace(db, slug, actor_user_id)
        # Validate folder is in this workspace (skip if no folder picked
        # — defaults to 미분류). One folder_id is applied to every new
        # mount; per-board variation requires separate POST calls.
        if folder_id is not None:
            _validate_folder_for_workspace(db, folder_id, slug)
        row = ReportMount(
            report_id=report_id,
            workspace_slug=slug,
            edit_policy=edit_policy,
            mounted_by_user_id=actor_user_id,
            note=note,
            folder_id=folder_id,
        )
        db.add(row)
        created.append(row)
    db.flush()

    # 게시(배치)된 게시판의 grant 자동 생성 — 정책에 따라 동기화(공유/권한
    # 개편: 가시성·편집은 grant 단일 출처).
    for row in created:
        _sync_mount_grants(
            db, report_id, row.workspace_slug, edit_policy, actor_user_id
        )

    # Notify the report owner that their report just got mounted (only
    # if someone else mounted it; self-mount is implicit).
    for row in created:
        if report.owner_user_id is not None and report.owner_user_id != actor_user_id:
            create_notification(
                db,
                recipient_user_id=report.owner_user_id,
                actor_user_id=actor_user_id,
                type=NotificationType.mount_new_to_me,
                ref_table="reports",
                ref_id=report_id,
                workspace_slug=row.workspace_slug,
                payload={"report_title": report.title},
            )
        # Notify the board lead so they see "new report on my board".
        lead_id = _board_lead_user_id(db, row.workspace_slug)
        if lead_id is not None:
            create_notification(
                db,
                recipient_user_id=lead_id,
                actor_user_id=actor_user_id,
                type=NotificationType.mount_new_in_board,
                ref_table="reports",
                ref_id=report_id,
                workspace_slug=row.workspace_slug,
                payload={"report_title": report.title},
            )

    # Phase auto-transition: the first time a report becomes publicly
    # visible (had no mounts → now has at least one), bump
    # drafting → reviewing. Matches §8.3 spec. Re-mounts after unmount
    # also trigger this if the report had returned to drafting.
    if not had_any_mount_before and created and report.phase == ReportPhase.drafting:
        report.phase = ReportPhase.reviewing
        if report.owner_user_id is not None:
            create_notification(
                db,
                recipient_user_id=report.owner_user_id,
                actor_user_id=actor_user_id,
                type=NotificationType.report_phase_to_reviewing,
                ref_table="reports",
                ref_id=report_id,
                payload={"trigger": "mount", "report_title": report.title},
            )

    return created


def set_mount_folder(
    db: Session,
    *,
    report_id: int,
    workspace_slug: str,
    folder_id: Optional[int],
    actor_user_id: int,
) -> ReportMount:
    """Metadata-only — move an existing mount between org folders (or
    to 미분류 with folder_id=None). Permission: report owner OR the
    mounter OR a workspace admin/manager on that board. Workspace
    members aren't allowed to reorganize someone else's report.
    """
    row = db.get(ReportMount, (report_id, workspace_slug))
    if row is None:
        raise MountTargetInvalidError(
            f"게시 정보를 찾을 수 없습니다: report={report_id} board={workspace_slug}"
        )
    report = db.get(Report, report_id)
    if report is None:
        raise MountTargetInvalidError(f"보고서를 찾을 수 없습니다: {report_id}")

    is_owner = report.owner_user_id == actor_user_id
    is_mounter = row.mounted_by_user_id == actor_user_id
    is_board_admin = False
    if not (is_owner or is_mounter):
        m = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.user_id == actor_user_id,
                WorkspaceMember.workspace_slug == workspace_slug,
            )
        ).scalar_one_or_none()
        # 매니저 (=옛 admin) 면 게시판 폴더를 옮길 수 있음.
        is_board_admin = m is not None and m.role == Role.manager
    if not (is_owner or is_mounter or is_board_admin):
        raise MountForbiddenError(
            "이 보고서의 폴더 위치를 변경할 권한이 없습니다."
        )

    if folder_id is not None:
        _validate_folder_for_workspace(db, folder_id, workspace_slug)
    row.folder_id = folder_id
    db.flush()
    return row


def set_mount_edit_policy(
    db: Session,
    *,
    report_id: int,
    workspace_slug: str,
    edit_policy: MountEditPolicy,
    actor_user_id: int,
) -> ReportMount:
    """Change the per-board edit policy. Phase 3.

    Owner-only — letting a board admin tighten a policy on someone
    else's report would be confusing ("내 보고서인데 왜 owner_only 가
    풀려있지?"). Folder placement was different because it's an
    organizational concern; policy is an author concern.
    """
    row = db.get(ReportMount, (report_id, workspace_slug))
    if row is None:
        raise MountTargetInvalidError(
            f"게시 정보를 찾을 수 없습니다: report={report_id} board={workspace_slug}"
        )
    report = db.get(Report, report_id)
    if report is None:
        raise MountTargetInvalidError(f"보고서를 찾을 수 없습니다: {report_id}")
    if report.owner_user_id != actor_user_id:
        raise MountForbiddenError(
            "편집 정책 변경은 작성자만 가능합니다."
        )
    row.edit_policy = edit_policy
    # 편집 권한은 grant 가 단일 출처 — 정책에 맞춰 동기화.
    _sync_mount_grants(db, report_id, workspace_slug, edit_policy, actor_user_id)
    db.flush()
    return row


def set_mount_note(
    db: Session,
    *,
    report_id: int,
    workspace_slug: str,
    note: str,
    actor_user_id: int,
) -> ReportMount:
    """게시 메모(자유 기재)를 수정한다. 권한은 폴더 이동과 동일 — 작성자 OR
    게시한 사람 OR 그 게시판 매니저. (메모는 조직 맥락이라 게시판 매니저도 손볼
    수 있게.)"""
    row = db.get(ReportMount, (report_id, workspace_slug))
    if row is None:
        raise MountTargetInvalidError(
            f"게시 정보를 찾을 수 없습니다: report={report_id} board={workspace_slug}"
        )
    report = db.get(Report, report_id)
    if report is None:
        raise MountTargetInvalidError(f"보고서를 찾을 수 없습니다: {report_id}")

    is_owner = report.owner_user_id == actor_user_id
    is_mounter = row.mounted_by_user_id == actor_user_id
    is_board_admin = False
    if not (is_owner or is_mounter):
        m = db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.user_id == actor_user_id,
                WorkspaceMember.workspace_slug == workspace_slug,
            )
        ).scalar_one_or_none()
        is_board_admin = m is not None and m.role == Role.manager
    if not (is_owner or is_mounter or is_board_admin):
        raise MountForbiddenError("이 게시의 메모를 수정할 권한이 없습니다.")

    row.note = (note or "").strip()
    db.flush()
    return row


def unmount_report(
    db: Session,
    *,
    report_id: int,
    workspace_slug: str,
    actor_user_id: int,
) -> bool:
    """Remove one mount. Idempotent — missing row returns False instead
    of erroring. Permission: report owner OR workspace admin on the
    board may unmount.

    Returns True if a row was deleted, False if it didn't exist.
    """
    report = db.get(Report, report_id)
    if report is None:
        raise MountTargetInvalidError(f"보고서를 찾을 수 없습니다: {report_id}")

    # 게시취소 권한: 그 게시판의 매니저(조상 매니저 포함) 또는 시스템관리자.
    # 작성자라도 그 게시판을 *관리*하지 않으면 직접 못 내린다 — 게시취소 요청
    # 큐(request_takedown)로 그 board 매니저의 승인을 받아야 한다(거버넌스).
    if not _can_unmount_board(db, actor_user_id, workspace_slug):
        raise MountForbiddenError(
            "이 게시판에서 게시취소할 권한이 없습니다 (게시판 매니저만 가능 — "
            "작성자는 '게시판에서 내리기 요청'을 보내세요)."
        )

    row = db.get(ReportMount, (report_id, workspace_slug))
    if row is None:
        return False
    db.delete(row)
    # 배치 해제 시 그 게시판 grant(부서 + 매니저) 제거(공유/권한 개편).
    grant_services.remove_workspace_grant(
        db, GrantContentType.report, report_id, workspace_slug
    )
    grant_services.remove_principal_grant(
        db,
        GrantContentType.report,
        report_id,
        GrantPrincipalType.workspace_manager,
        workspace_slug,
    )
    # 감사 로그 — 게시취소 이벤트(수동 해제·게시취소 요청 승인 모두 이 경로).
    from app.modules.activities.models import ReportActivityType
    from app.modules.activities.services import record_activity

    record_activity(
        db,
        report_id=report_id,
        type=ReportActivityType.unmounted,
        actor_user_id=actor_user_id,
        payload={"workspace_slug": workspace_slug},
    )
    db.flush()
    return True


# --------------------------------------------------------------------------- #
# 게시취소 요청 큐 (보고서 삭제 재설계 2단계)
# --------------------------------------------------------------------------- #
def _can_unmount_board(db: Session, user_id: int, workspace_slug: str) -> bool:
    """이 게시판에서 직접 게시취소할 수 있나 — 그 board 매니저(조상 매니저
    포함) 또는 시스템관리자. 작성자라도 board 를 관리하지 않으면 False(요청
    큐를 통해야 함)."""
    # 지역 import — _resolve_role 은 auth leaf util(순환 import 회피).
    from app.shared.auth import _resolve_role

    actor = db.get(User, user_id)
    if actor is not None and getattr(actor, "is_system_admin", False):
        return True
    return _resolve_role(db, user_id, workspace_slug) == Role.manager


def _assert_board_manager(db: Session, user_id: int, workspace_slug: str) -> None:
    if not _can_unmount_board(db, user_id, workspace_slug):
        raise MountForbiddenError(
            "이 게시판의 게시취소 요청을 처리할 권한이 없습니다 (게시판 매니저만 가능)."
        )


def request_takedown(db: Session, *, report_id: int, actor_user_id: int) -> dict:
    """작성자가 "게시판에서 내리기"를 요청 — 게시(mount)된 부서 게시판마다
    팬아웃. 요청자가 *관리하는* 게시판은 즉시 게시취소(자동 승인), 나머지는
    pending 요청을 만들어 그 board 매니저의 승인을 기다린다. 권한: 작성자
    본인 또는 시스템관리자."""
    report = db.get(Report, report_id)
    if report is None:
        raise MountTargetInvalidError(f"보고서를 찾을 수 없습니다: {report_id}")
    actor = db.get(User, actor_user_id)
    is_sysadmin = bool(getattr(actor, "is_system_admin", False))
    if not (is_sysadmin or report.owner_user_id == actor_user_id):
        raise MountForbiddenError("본인 보고서만 게시취소를 요청할 수 있습니다.")

    mounts = (
        db.execute(select(ReportMount).where(ReportMount.report_id == report_id))
        .scalars()
        .all()
    )
    requested = 0
    auto_removed = 0
    for m in mounts:
        slug = m.workspace_slug
        if _can_unmount_board(db, actor_user_id, slug):
            # 관리하는 board — 즉시 게시취소 + 자동 승인 행(감사용).
            unmount_report(
                db,
                report_id=report_id,
                workspace_slug=slug,
                actor_user_id=actor_user_id,
            )
            db.add(
                ReportTakedownRequest(
                    report_id=report_id,
                    workspace_slug=slug,
                    requested_by_user_id=actor_user_id,
                    status=TakedownStatus.approved,
                    decided_by_user_id=actor_user_id,
                    decided_at=datetime.utcnow(),
                )
            )
            auto_removed += 1
        else:
            # 중복 pending 방지.
            existing = db.execute(
                select(ReportTakedownRequest).where(
                    ReportTakedownRequest.report_id == report_id,
                    ReportTakedownRequest.workspace_slug == slug,
                    ReportTakedownRequest.status == TakedownStatus.pending,
                )
            ).scalar_one_or_none()
            if existing is None:
                db.add(
                    ReportTakedownRequest(
                        report_id=report_id,
                        workspace_slug=slug,
                        requested_by_user_id=actor_user_id,
                        status=TakedownStatus.pending,
                    )
                )
                requested += 1
    db.commit()
    return {"requested": requested, "auto_removed": auto_removed}


def list_takedown_requests(
    db: Session, *, workspace_slug: str, actor_user_id: int
) -> list[ReportTakedownRequest]:
    """이 게시판에 들어온 pending 게시취소 요청 — 그 board 매니저(조상 포함)/
    시스템관리자만 조회."""
    _assert_board_manager(db, actor_user_id, workspace_slug)
    return list(
        db.execute(
            select(ReportTakedownRequest)
            .where(
                ReportTakedownRequest.workspace_slug == workspace_slug,
                ReportTakedownRequest.status == TakedownStatus.pending,
            )
            .order_by(ReportTakedownRequest.created_at)
        ).scalars()
    )


def _decide_takedown(
    db: Session, *, request_id: int, actor_user_id: int, approve: bool
) -> ReportTakedownRequest:
    req = db.get(ReportTakedownRequest, request_id)
    if req is None:
        raise MountTargetInvalidError(f"요청을 찾을 수 없습니다: {request_id}")
    if req.status != TakedownStatus.pending:
        raise MountForbiddenError("이미 처리된 요청입니다.")
    _assert_board_manager(db, actor_user_id, req.workspace_slug)
    if approve:
        # 승인 → 그 게시판에서 게시취소(이미 내려갔으면 idempotent).
        unmount_report(
            db,
            report_id=req.report_id,
            workspace_slug=req.workspace_slug,
            actor_user_id=actor_user_id,
        )
        req.status = TakedownStatus.approved
    else:
        req.status = TakedownStatus.rejected
    req.decided_by_user_id = actor_user_id
    req.decided_at = datetime.utcnow()
    db.commit()
    db.refresh(req)
    return req


def approve_takedown(db: Session, *, request_id: int, actor_user_id: int):
    return _decide_takedown(
        db, request_id=request_id, actor_user_id=actor_user_id, approve=True
    )


def reject_takedown(db: Session, *, request_id: int, actor_user_id: int):
    return _decide_takedown(
        db, request_id=request_id, actor_user_id=actor_user_id, approve=False
    )


def cancel_takedowns_for_report(db: Session, report_id: int) -> int:
    """이 보고서의 진행 중(pending) 게시취소 요청을 모두 철회 — 휴지통 복구
    시 호출(복구=요청 철회). 커밋은 호출부가 한다."""
    pendings = (
        db.execute(
            select(ReportTakedownRequest).where(
                ReportTakedownRequest.report_id == report_id,
                ReportTakedownRequest.status == TakedownStatus.pending,
            )
        )
        .scalars()
        .all()
    )
    now = datetime.utcnow()
    for p in pendings:
        p.status = TakedownStatus.canceled
        p.decided_at = now
    return len(pendings)
