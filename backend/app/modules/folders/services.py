"""Folder service layer — personal + org scopes in one module.

Two flavors, distinguished by `Folder.kind`:

  * personal — owned by a user (`user_id` set). Visible & mutable only
    by that user (workspace admin can override via a separate flow if
    we ever need it; not in Phase 1.6).
  * org — workspace-wide shared (`workspace_slug` set). All workspace
    members can SEE the tree; mutate (create/rename/move/delete) is
    restricted to workspace admin/lead.

Default folder set ("진행 중", "종결", "보관") is created lazily on
first list call — per-user for personal, per-workspace for org. Once
the user / workspace has any folder (default or self-created), the
helper becomes a no-op so we never reinstate folders that were
explicitly deleted.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.modules.folders.models import Folder, FolderKind
from app.modules.mounts.models import ReportMount
from app.modules.reports.models import Report
from app.modules.users.models import Role, WorkspaceMember
from app.modules.workspaces.models import Workspace, WorkspaceKind


DEFAULT_FOLDERS: list[tuple[str, int]] = [
    ("진행 중", 0),
    ("종결", 10),
    ("보관", 20),
]


class FolderError(Exception):
    code = "folder_error"
    status_code = 400


class FolderNotFoundError(FolderError):
    code = "folder_not_found"
    status_code = 404


class FolderForbiddenError(FolderError):
    code = "folder_forbidden"
    status_code = 403


# ──────────────────────────────────────────────────────────────────
# Scope helpers — the "personal vs org" branch is the single source
# of complexity in this module; centralized here so the rest of the
# functions can stay flavor-agnostic.
# ──────────────────────────────────────────────────────────────────


def _is_workspace_admin(db: Session, user_id: int, workspace_slug: str) -> bool:
    """A user can mutate an org workspace's folder tree if they have
    admin or manager role *anywhere up the workspace tree*. Walking the
    parent chain matches the rest of the codebase's role resolution
    (see app/shared/auth.py:_resolve_role)."""
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
        if m and m.role == Role.manager:
            return True
        ws = db.get(Workspace, cur)
        if not ws:
            break
        cur = ws.parent_slug
    return False


def _ensure_org_workspace(db: Session, workspace_slug: str) -> Workspace:
    ws = db.get(Workspace, workspace_slug)
    if ws is None:
        raise FolderError(f"워크스페이스를 찾을 수 없습니다: {workspace_slug}")
    if ws.kind != WorkspaceKind.org:
        raise FolderError(
            f"조직 워크스페이스에만 공유 폴더를 만들 수 있습니다 (kind={ws.kind.value})."
        )
    return ws


# ──────────────────────────────────────────────────────────────────
# Default folder creation
# ──────────────────────────────────────────────────────────────────


def ensure_default_folders_for_user(db: Session, user_id: int) -> None:
    exists = db.execute(
        select(Folder.id).where(Folder.user_id == user_id).limit(1)
    ).first()
    if exists:
        return
    for name, sort_order in DEFAULT_FOLDERS:
        db.add(
            Folder(
                kind=FolderKind.personal,
                user_id=user_id,
                workspace_slug=None,
                parent_id=None,
                name=name,
                sort_order=sort_order,
            )
        )
    db.flush()


def ensure_default_folders_for_workspace(db: Session, workspace_slug: str) -> None:
    exists = db.execute(
        select(Folder.id)
        .where(Folder.workspace_slug == workspace_slug)
        .limit(1)
    ).first()
    if exists:
        return
    for name, sort_order in DEFAULT_FOLDERS:
        db.add(
            Folder(
                kind=FolderKind.org,
                user_id=None,
                workspace_slug=workspace_slug,
                parent_id=None,
                name=name,
                sort_order=sort_order,
            )
        )
    db.flush()


# ──────────────────────────────────────────────────────────────────
# Listing — with report_count annotation
# ──────────────────────────────────────────────────────────────────


def list_personal_folders(db: Session, user_id: int) -> list[Folder]:
    """Personal folders, `report_count` annotated via the Reports table
    (since personal placement lives on Report.folder_id)."""
    ensure_default_folders_for_user(db, user_id)
    rows = db.execute(
        select(Folder, func.count(Report.id).label("report_count"))
        .outerjoin(Report, Report.folder_id == Folder.id)
        .where(Folder.kind == FolderKind.personal, Folder.user_id == user_id)
        .group_by(Folder.id)
        .order_by(Folder.sort_order, Folder.id)
    ).all()
    folders: list[Folder] = []
    for folder, count in rows:
        folder.report_count = int(count or 0)
        folders.append(folder)
    return folders


def list_org_folders(db: Session, workspace_slug: str) -> list[Folder]:
    """Org folders, `report_count` annotated via ReportMount (since org
    placement lives on ReportMount.folder_id, not Report.folder_id)."""
    ensure_default_folders_for_workspace(db, workspace_slug)
    rows = db.execute(
        select(Folder, func.count(ReportMount.report_id).label("report_count"))
        .outerjoin(ReportMount, ReportMount.folder_id == Folder.id)
        .where(
            Folder.kind == FolderKind.org,
            Folder.workspace_slug == workspace_slug,
        )
        .group_by(Folder.id)
        .order_by(Folder.sort_order, Folder.id)
    ).all()
    folders: list[Folder] = []
    for folder, count in rows:
        folder.report_count = int(count or 0)
        folders.append(folder)
    return folders


def count_uncategorized_personal(db: Session, user_id: int) -> int:
    personal_slug = f"personal-{user_id}"
    n = db.execute(
        select(func.count(Report.id)).where(
            Report.workspace_slug == personal_slug,
            Report.folder_id.is_(None),
        )
    ).scalar()
    return int(n or 0)


def count_uncategorized_org(db: Session, workspace_slug: str) -> int:
    """Mounts in this workspace with no folder assignment."""
    return count_uncategorized_org_multi(db, [workspace_slug])


def count_uncategorized_org_multi(db: Session, workspace_slugs) -> int:
    """폴더 미지정 mount 수 — 여러 부서 게시판을 한 번에 합산(하위부서 포함용).
    빈 입력이면 0."""
    slugs = list(workspace_slugs or [])
    if not slugs:
        return 0
    n = db.execute(
        select(func.count(ReportMount.report_id)).where(
            ReportMount.workspace_slug.in_(slugs),
            ReportMount.folder_id.is_(None),
        )
    ).scalar()
    return int(n or 0)


def list_public_org_folders(db: Session, workspace_slug: str) -> list[Folder]:
    """비멤버 외부 열람자(public_viewer)에게 보일 *공개 폴더만*
    (조직간공개_설계.md Phase 5). effective external_view 가 TRUE 인 폴더만 —
    폴더 own override 가 있으면 그 값, 없으면 게시판 기본값(external_view_default).
    기본 생성(default-create) 부작용 없음: 남의 게시판에 폴더를 만들면 안 된다."""
    ws = db.get(Workspace, workspace_slug)
    if ws is None:
        return []
    default = bool(ws.external_view_default)
    rows = db.execute(
        select(Folder, func.count(ReportMount.report_id).label("report_count"))
        .outerjoin(ReportMount, ReportMount.folder_id == Folder.id)
        .where(
            Folder.kind == FolderKind.org,
            Folder.workspace_slug == workspace_slug,
        )
        .group_by(Folder.id)
        .order_by(Folder.sort_order, Folder.id)
    ).all()
    out: list[Folder] = []
    for folder, count in rows:
        eff = folder.external_view if folder.external_view is not None else default
        if not eff:
            continue
        folder.report_count = int(count or 0)
        out.append(folder)
    return out


def count_public_uncategorized_org(db: Session, workspace_slug: str) -> int:
    """미분류(folder 없음) mount 는 게시판 기본값이 공개일 때만 외부 열람자에게
    잡힌다(폴더가 없으니 게시판 기본값을 그대로 탐). 그 외엔 0."""
    ws = db.get(Workspace, workspace_slug)
    if ws is None or not ws.external_view_default:
        return 0
    return count_uncategorized_org(db, workspace_slug)


def list_org_folders_visible(
    db: Session, workspace_slug: str, visible_ids: set[int]
) -> list[Folder]:
    """비멤버(grant/public 뷰어)용 — 이 게시판 폴더 중 *가시 보고서가 든 폴더만*
    (report_count = 가시 보고서 수). 멤버용 list_org_folders 와 달리 mount 전체가
    아니라 visible_ids 로 카운트해 보고서 목록과 숫자가 일치한다(폴더 18·목록 3
    불일치 해소). 가시 보고서가 0인 폴더는 빈 폴더라 노이즈 방지차 숨긴다."""
    if not visible_ids:
        return []
    rows = db.execute(
        select(Folder, func.count(ReportMount.report_id).label("report_count"))
        .join(
            ReportMount,
            and_(
                ReportMount.folder_id == Folder.id,
                ReportMount.report_id.in_(visible_ids),
            ),
        )
        .where(
            Folder.kind == FolderKind.org,
            Folder.workspace_slug == workspace_slug,
        )
        .group_by(Folder.id)
        .order_by(Folder.sort_order, Folder.id)
    ).all()
    out: list[Folder] = []
    for folder, count in rows:
        folder.report_count = int(count or 0)
        out.append(folder)
    return out


def count_uncategorized_org_visible(
    db: Session, workspace_slug: str, visible_ids: set[int]
) -> int:
    """비멤버 뷰어용 — 이 게시판의 미분류(folder 없음) mount 중 가시 보고서 수."""
    if not visible_ids:
        return 0
    return int(
        db.execute(
            select(func.count(ReportMount.report_id)).where(
                ReportMount.workspace_slug == workspace_slug,
                ReportMount.folder_id.is_(None),
                ReportMount.report_id.in_(visible_ids),
            )
        ).scalar()
        or 0
    )


def list_org_folders_with_counts(
    db: Session, workspace_slug: str, visible_ids: set[int]
) -> list[Folder]:
    """게시판/폴더를 공유받아 브라우즈하는 *비멤버*용 — 보고서가 든 폴더(전체)에
    대해 report_count=열람 가능 수, total_count=전체 수 를 채운다. 프론트가
    '총 N개 중 M개 열람'으로 표시해, 못 여는 게 더 있음을 알린다(열람 0개 폴더도
    포함). 빈 폴더(전체 0)는 제외."""
    folders = list(
        db.execute(
            select(Folder)
            .where(
                Folder.kind == FolderKind.org,
                Folder.workspace_slug == workspace_slug,
            )
            .order_by(Folder.sort_order, Folder.id)
        ).scalars()
    )
    if not folders:
        return []
    total_by = {
        fid: int(c or 0)
        for fid, c in db.execute(
            select(ReportMount.folder_id, func.count(ReportMount.report_id))
            .where(
                ReportMount.workspace_slug == workspace_slug,
                ReportMount.folder_id.is_not(None),
            )
            .group_by(ReportMount.folder_id)
        ).all()
    }
    view_by: dict[int, int] = {}
    if visible_ids:
        view_by = {
            fid: int(c or 0)
            for fid, c in db.execute(
                select(ReportMount.folder_id, func.count(ReportMount.report_id))
                .where(
                    ReportMount.workspace_slug == workspace_slug,
                    ReportMount.folder_id.is_not(None),
                    ReportMount.report_id.in_(visible_ids),
                )
                .group_by(ReportMount.folder_id)
            ).all()
        }
    out: list[Folder] = []
    for f in folders:
        total = total_by.get(f.id, 0)
        if total == 0:
            continue  # 빈 폴더 제외
        f.report_count = view_by.get(f.id, 0)
        f.total_count = total
        out.append(f)
    return out


def list_org_folders_readonly(db: Session, workspace_slug: str) -> list[Folder]:
    """list_org_folders 와 동일하나 기본 폴더 생성(side effect) 없음. '하위부서
    포함' 트리에서 자손 게시판을 *읽기만* 할 때, 남의 게시판에 기본 폴더를
    만들지 않도록 한다."""
    rows = db.execute(
        select(Folder, func.count(ReportMount.report_id).label("report_count"))
        .outerjoin(ReportMount, ReportMount.folder_id == Folder.id)
        .where(
            Folder.kind == FolderKind.org,
            Folder.workspace_slug == workspace_slug,
        )
        .group_by(Folder.id)
        .order_by(Folder.sort_order, Folder.id)
    ).all()
    folders: list[Folder] = []
    for folder, count in rows:
        folder.report_count = int(count or 0)
        folders.append(folder)
    return folders


def descendant_folder_tree(db: Session, root_slug: str, actor) -> list[tuple]:
    """'하위부서 포함' 트리 — root 의 자손(하위) org 부서들 중 actor 가 *볼 수
    있는* 것과 각 부서의 보이는 폴더를 (Workspace, [Folder]) 튜플 목록으로 반환.

    권한: 멤버(상속 포함 — 상위 부서 멤버는 하위도 멤버) → 전체 폴더. 비멤버라도
    공개 컨텐츠가 있으면 공개 폴더만. 그 외(접근 불가)는 제외 → 권한 밖 부서는
    이름조차 노출되지 않는다. root 자신은 제외(호출부가 기존 목록으로 따로 그림).
    """
    # 지역 import — 순환참조 회피(auth → … → folders 경로).
    from app.modules.workspaces import services as ws_services
    from app.shared.auth import _resolve_role, _workspace_has_public_content

    slugs = ws_services.get_descendants_inclusive(db, root_slug)
    out: list[tuple] = []
    for slug in slugs:
        if slug == root_slug:
            continue
        ws = db.get(Workspace, slug)
        if ws is None or ws.virtual or ws.kind != WorkspaceKind.org:
            continue
        is_member = (
            actor.is_system_admin
            or _resolve_role(db, actor.id, slug) is not None
        )
        if is_member:
            folders = list_org_folders_readonly(db, slug)
        elif _workspace_has_public_content(db, slug):
            folders = list_public_org_folders(db, slug)
            if not folders:
                continue
        else:
            continue
        out.append((ws, folders))
    return out


# ──────────────────────────────────────────────────────────────────
# Mutation — permission-checked
# ──────────────────────────────────────────────────────────────────


def _get_folder_with_permission(
    db: Session,
    folder_id: int,
    actor_user_id: int,
    *,
    actor_is_system_admin: bool = False,
) -> Folder:
    """Fetch a folder + verify the actor may mutate it. Raises
    FolderNotFoundError / FolderForbiddenError.

    actor_is_system_admin: 시스템 관리자는 다른 가입자의 개인 폴더·다른
    부서의 조직 폴더 모두 수정 가능 (시스템 내 모든 데이터 CRUD 정책)."""
    folder = db.get(Folder, folder_id)
    if folder is None:
        raise FolderNotFoundError(f"폴더를 찾을 수 없습니다: {folder_id}")
    if actor_is_system_admin:
        return folder
    if folder.kind == FolderKind.personal:
        if folder.user_id != actor_user_id:
            raise FolderForbiddenError("본인 소유 폴더만 수정할 수 있습니다.")
    else:  # org
        if not _is_workspace_admin(db, actor_user_id, folder.workspace_slug):
            raise FolderForbiddenError(
                "조직 폴더는 워크스페이스 관리자만 수정할 수 있습니다."
            )
    return folder


def create_personal_folder(
    db: Session,
    *,
    user_id: int,
    name: str,
    parent_id: Optional[int] = None,
    sort_order: int = 0,
) -> Folder:
    if parent_id is not None:
        parent = _get_folder_with_permission(db, parent_id, user_id)
        if parent.kind != FolderKind.personal:
            raise FolderError(
                "개인 폴더의 부모는 같은 개인 폴더여야 합니다."
            )
    folder = Folder(
        kind=FolderKind.personal,
        user_id=user_id,
        workspace_slug=None,
        parent_id=parent_id,
        name=name.strip(),
        sort_order=sort_order,
    )
    db.add(folder)
    db.flush()
    return folder


def create_org_folder(
    db: Session,
    *,
    workspace_slug: str,
    actor_user_id: int,
    name: str,
    parent_id: Optional[int] = None,
    sort_order: int = 0,
) -> Folder:
    _ensure_org_workspace(db, workspace_slug)
    if not _is_workspace_admin(db, actor_user_id, workspace_slug):
        raise FolderForbiddenError(
            "조직 폴더 생성 권한이 없습니다 (admin/manager 필요)."
        )
    if parent_id is not None:
        parent = db.get(Folder, parent_id)
        if (
            parent is None
            or parent.kind != FolderKind.org
            or parent.workspace_slug != workspace_slug
        ):
            raise FolderError(
                "조직 폴더의 부모는 같은 워크스페이스 폴더여야 합니다."
            )
    folder = Folder(
        kind=FolderKind.org,
        user_id=None,
        workspace_slug=workspace_slug,
        parent_id=parent_id,
        name=name.strip(),
        sort_order=sort_order,
    )
    db.add(folder)
    db.flush()
    return folder


def update_folder(
    db: Session,
    *,
    folder_id: int,
    actor_user_id: int,
    actor_is_system_admin: bool = False,
    name: Optional[str] = None,
    parent_id_set: bool = False,
    parent_id: Optional[int] = None,
    sort_order: Optional[int] = None,
    external_view_set: bool = False,
    external_view: Optional[bool] = None,
) -> Folder:
    folder = _get_folder_with_permission(
        db, folder_id, actor_user_id, actor_is_system_admin=actor_is_system_admin
    )
    if name is not None:
        folder.name = name.strip()
    if external_view_set:
        # 공개 override 는 org 폴더 전용(조직간공개_설계.md §4.2) — 개인 폴더는
        # 공개 대상이 아니다. _get_folder_with_permission 이 이미 매니저/소유자
        # 게이트를 통과시켰으므로 여기선 종류만 막는다. null=상속/True/False.
        if folder.kind != FolderKind.org:
            raise FolderError("개인 폴더는 공개 설정을 가질 수 없습니다.")
        folder.external_view = external_view
    if parent_id_set:
        if parent_id is not None:
            if parent_id == folder_id:
                raise FolderError(
                    "폴더를 자기 자신의 하위로 이동할 수 없습니다."
                )
            new_parent = db.get(Folder, parent_id)
            if new_parent is None:
                raise FolderNotFoundError(
                    f"새 부모 폴더를 찾을 수 없습니다: {parent_id}"
                )
            # Parent must be in the same scope as the moved folder —
            # otherwise we'd silently change ownership.
            if new_parent.kind != folder.kind:
                raise FolderError(
                    "다른 종류 (개인/조직) 의 폴더로 이동할 수 없습니다."
                )
            if (
                folder.kind == FolderKind.org
                and new_parent.workspace_slug != folder.workspace_slug
            ):
                raise FolderError(
                    "다른 워크스페이스로 폴더를 옮길 수 없습니다."
                )
            if (
                folder.kind == FolderKind.personal
                and new_parent.user_id != folder.user_id
            ):
                raise FolderError(
                    "다른 사용자 폴더 아래로 옮길 수 없습니다."
                )
            # Cycle detection — walk up and ensure we don't loop back.
            cur = new_parent
            seen = {folder_id}
            while cur is not None:
                if cur.id in seen:
                    raise FolderError(
                        "순환 구조가 됩니다 — 다른 부모를 선택하세요."
                    )
                seen.add(cur.id)
                cur = db.get(Folder, cur.parent_id) if cur.parent_id else None
        folder.parent_id = parent_id
    if sort_order is not None:
        folder.sort_order = sort_order
    db.flush()
    return folder


def delete_folder(
    db: Session,
    *,
    folder_id: int,
    actor_user_id: int,
    actor_is_system_admin: bool = False,
) -> None:
    folder = _get_folder_with_permission(
        db, folder_id, actor_user_id, actor_is_system_admin=actor_is_system_admin
    )
    db.delete(folder)
    db.flush()
