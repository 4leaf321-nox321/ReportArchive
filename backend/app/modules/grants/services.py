"""통합 공유(grant) 판정 로직 — 보고서·종합보고 공통 단일 출처.

핵심 규칙(계획: 보고서·종합보고 공유/권한 체계 개편):

- **하위 상속, 상위 자동열람 없음.** 부서 X 에 공유 → X 와 X 의 하위 부서가 도달.
- 가시성(can_view)은 *보는 사람의 활성 게시판 W* 기준: 부서 grant X 가
  `X ∈ ancestor_slugs_inclusive(W)` 면 도달(W 가 X 이거나 X 의 하위면 참).
- 편집(reachable_workspace_edit)은 *활성 게시판과 무관* — 사용자의 실제 소속이
  granted 부서 X 또는 그 하위인지로 판정(`소속 slug ∩ descendants(X)`).
  ⚠️ 절대 `_resolve_role`(상위 워크)로 판정하지 말 것 — 상위 누수 재발.
- all_org 는 view 전용(공개 열람).
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import and_, delete as sa_delete, or_, select
from sqlalchemy.orm import Session

from app.modules.grants.models import (
    BoardGrant,
    ContentGrant,
    FolderGrant,
    GrantContentType,
    GrantLevel,
    GrantPrincipalType,
)


# --------------------------------------------------------------------------- #
# 트리 헬퍼
# --------------------------------------------------------------------------- #
def ancestor_slugs_inclusive(db: Session, slug: str) -> set[str]:
    """{slug} ∪ 조상 slug 들. 부서 grant 의 *하위 상속* 도달 판정에 쓴다 —
    grant 대상 X 가 이 집합에 있으면 활성 게시판(slug)이 X 이거나 X 의 하위."""
    from app.modules.workspaces import services as ws_services

    return {slug} | {a.slug for a in ws_services.get_ancestors(db, slug)}


def _user_membership_slugs(db: Session, user_id: int) -> set[str]:
    from app.modules.users.models import WorkspaceMember

    return set(
        db.execute(
            select(WorkspaceMember.workspace_slug).where(
                WorkspaceMember.user_id == user_id
            )
        ).scalars()
    )


def membership_reach_slugs(db: Session, user_id: int) -> set[str]:
    """비멤버(public_viewer)의 *view* 가시성 판정용 — 이 사용자에게 **실제 소속
    (멤버십) 기준**으로 도달하는 부서 grant 대상 slug 집합.

    멤버 경로는 active workspace(X-Workspace-Slug)의 조상으로 도달을 판정하지만,
    비멤버는 헤더를 위조해 임의 게시판을 active 로 둘 수 있으므로 헤더를 신뢰하면
    안 된다. 대신 멤버십 M 마다:
      - ancestor_slugs_inclusive(M) : 상위 부서가 공유하면 하위(나)가 본다(하향 공유)
      - get_descendants_inclusive(M): 역할 하향상속으로 내가 접근 가능한 게시판들
    을 합쳐, member 의 active-ws 경로가 어느 게시판에 있든 닿을 수 있던 집합과
    동치이되 신원에 기반한다."""
    from app.modules.workspaces import services as ws_services

    reach: set[str] = set()
    for m in _user_membership_slugs(db, user_id):
        reach |= ancestor_slugs_inclusive(db, m)
        reach |= set(ws_services.get_descendants_inclusive(db, m))
    return reach


def _actor_view_reach(db: Session, actor) -> set[str]:
    """view 도달 판정에 쓸 부서 slug 집합. 멤버는 active workspace 의 조상(기존
    동작 그대로 — 무회귀), 비멤버(public_viewer)는 멤버십 기반(헤더 위조 차단)."""
    if getattr(actor, "public_viewer", False):
        return membership_reach_slugs(db, actor.user.id)
    return ancestor_slugs_inclusive(db, actor.workspace.slug)


# --------------------------------------------------------------------------- #
# grant 존재 판정 (단건)
# --------------------------------------------------------------------------- #
def has_all_org_grant(
    db: Session, content_type: GrantContentType, content_id: int
) -> bool:
    return (
        db.execute(
            select(ContentGrant.id)
            .where(
                ContentGrant.content_type == content_type,
                ContentGrant.content_id == content_id,
                ContentGrant.principal_type == GrantPrincipalType.all_org,
            )
            .limit(1)
        ).first()
        is not None
    )


def has_user_grant(
    db: Session,
    content_type: GrantContentType,
    content_id: int,
    user_id: int,
    *,
    level: Optional[GrantLevel] = None,
) -> bool:
    q = select(ContentGrant.id).where(
        ContentGrant.content_type == content_type,
        ContentGrant.content_id == content_id,
        ContentGrant.principal_type == GrantPrincipalType.user,
        ContentGrant.principal_ref == str(user_id),
    )
    if level is not None:
        q = q.where(ContentGrant.level == level)
    return db.execute(q.limit(1)).first() is not None


def _workspace_grant_slugs(
    db: Session,
    content_type: GrantContentType,
    content_id: int,
    *,
    level: Optional[GrantLevel] = None,
) -> set[str]:
    q = select(ContentGrant.principal_ref).where(
        ContentGrant.content_type == content_type,
        ContentGrant.content_id == content_id,
        ContentGrant.principal_type == GrantPrincipalType.workspace,
    )
    if level is not None:
        q = q.where(ContentGrant.level == level)
    return {s for s in db.execute(q).scalars() if s}


def reachable_workspace_view(
    db: Session,
    content_type: GrantContentType,
    content_id: int,
    actor_workspace_slug: str,
) -> bool:
    """부서 grant(level 무관)가 활성 게시판 W 에 도달하나(하위 상속).
    X ∈ ancestor_slugs_inclusive(W)."""
    grant_slugs = _workspace_grant_slugs(db, content_type, content_id)
    if not grant_slugs:
        return False
    return bool(grant_slugs & ancestor_slugs_inclusive(db, actor_workspace_slug))


def reachable_workspace_edit(
    db: Session, content_type: GrantContentType, content_id: int, user_id: int
) -> bool:
    """edit 부서 grant 가 사용자에게 도달하나 — 사용자가 granted 부서 X 또는
    그 하위 부서의 멤버인지(소속 slug ∩ descendants_inclusive(X))."""
    grant_slugs = _workspace_grant_slugs(db, content_type, content_id, level=GrantLevel.edit)
    if not grant_slugs:
        return False
    member_slugs = _user_membership_slugs(db, user_id)
    if not member_slugs:
        return False
    from app.modules.workspaces import services as ws_services

    for x in grant_slugs:
        if member_slugs & set(ws_services.get_descendants_inclusive(db, x)):
            return True
    return False


# --------------------------------------------------------------------------- #
# 게시판(board) grant — 게시판 통째 공유. 콘텐츠의 board(s) 경유로 합산.
# --------------------------------------------------------------------------- #
def _content_board_slugs(
    db: Session, content_type: GrantContentType, content_id: int
) -> list[str]:
    """이 콘텐츠가 속한 게시판 slug 들. 보고서=게시(mount)된 게시판 전부,
    종합보고=home 게시판 1개."""
    if content_type == GrantContentType.report:
        from app.modules.mounts.models import ReportMount

        return list(
            db.execute(
                select(ReportMount.workspace_slug).where(
                    ReportMount.report_id == content_id
                )
            ).scalars()
        )
    from app.modules.composites.models import CompositeReport

    c = db.get(CompositeReport, content_id)
    return [c.workspace_slug] if c is not None else []


def board_has_all_org(db: Session, board_slugs) -> bool:
    if not board_slugs:
        return False
    return (
        db.execute(
            select(BoardGrant.id)
            .where(
                BoardGrant.board_slug.in_(list(board_slugs)),
                BoardGrant.principal_type == GrantPrincipalType.all_org,
            )
            .limit(1)
        ).first()
        is not None
    )


def _board_view_reaches(db: Session, board_slugs, actor, *, include_all_org: bool) -> bool:
    """board grant 가 actor 에게 (열람) 도달하나. include_all_org=False 면 멤버
    경로만(all_org 제외) — is_member_view 판정용."""
    if not board_slugs:
        return False
    anc = _actor_view_reach(db, actor)
    clauses = [
        and_(
            BoardGrant.principal_type == GrantPrincipalType.user,
            BoardGrant.principal_ref == str(actor.user.id),
        ),
        and_(
            BoardGrant.principal_type == GrantPrincipalType.workspace,
            BoardGrant.principal_ref.in_(anc),
        ),
    ]
    if include_all_org:
        clauses.append(BoardGrant.principal_type == GrantPrincipalType.all_org)
    return (
        db.execute(
            select(BoardGrant.id)
            .where(BoardGrant.board_slug.in_(list(board_slugs)), or_(*clauses))
            .limit(1)
        ).first()
        is not None
    )


def _board_edit_reaches(db: Session, board_slugs, user_id: int) -> bool:
    """edit board grant 가 user 에게 도달하나 — user grant 직접 또는 부서 grant
    하위도달(소속 ∩ descendants)."""
    if not board_slugs:
        return False
    rows = db.execute(
        select(BoardGrant.principal_type, BoardGrant.principal_ref).where(
            BoardGrant.board_slug.in_(list(board_slugs)),
            BoardGrant.level == GrantLevel.edit,
        )
    ).all()
    if not rows:
        return False
    member_slugs = None
    from app.modules.workspaces import services as ws_services

    for ptype, pref in rows:
        if ptype == GrantPrincipalType.user and pref == str(user_id):
            return True
        if ptype == GrantPrincipalType.workspace and pref:
            if member_slugs is None:
                member_slugs = _user_membership_slugs(db, user_id)
            if member_slugs & set(ws_services.get_descendants_inclusive(db, pref)):
                return True
    return False


def _boards_view_reachable_slugs(
    db: Session, reach: set[str], user_id: int
) -> set[str]:
    """(열람) 도달하는 board slug 집합 — 목록/그래프 대량 판정용. `reach` 는 부서
    grant 도달 slug(멤버는 active-ws 조상, 비멤버는 멤버십 기반)."""
    return set(
        db.execute(
            select(BoardGrant.board_slug).where(
                or_(
                    BoardGrant.principal_type == GrantPrincipalType.all_org,
                    and_(
                        BoardGrant.principal_type == GrantPrincipalType.user,
                        BoardGrant.principal_ref == str(user_id),
                    ),
                    and_(
                        BoardGrant.principal_type == GrantPrincipalType.workspace,
                        BoardGrant.principal_ref.in_(reach or {""}),
                    ),
                )
            )
        ).scalars()
    )


# --------------------------------------------------------------------------- #
# 폴더(folder) grant — 게시판보다 좁은 단위. 보고서의 mount.folder_id 경유.
# --------------------------------------------------------------------------- #
def _content_folder_ids(
    db: Session, content_type: GrantContentType, content_id: int
) -> list[int]:
    """이 콘텐츠가 놓인 폴더 id 들. 보고서=mount 의 folder_id(NULL 제외),
    종합보고=폴더 개념 없음([])."""
    if content_type != GrantContentType.report:
        return []
    from app.modules.mounts.models import ReportMount

    return [
        fid
        for fid in db.execute(
            select(ReportMount.folder_id).where(
                ReportMount.report_id == content_id,
                ReportMount.folder_id.isnot(None),
            )
        ).scalars()
        if fid is not None
    ]


def folder_has_all_org(db: Session, folder_ids) -> bool:
    folder_ids = list(folder_ids)
    if not folder_ids:
        return False
    return (
        db.execute(
            select(FolderGrant.id)
            .where(
                FolderGrant.folder_id.in_(folder_ids),
                FolderGrant.principal_type == GrantPrincipalType.all_org,
            )
            .limit(1)
        ).first()
        is not None
    )


def _folder_view_reaches(db: Session, folder_ids, actor, *, include_all_org: bool) -> bool:
    folder_ids = list(folder_ids)
    if not folder_ids:
        return False
    anc = _actor_view_reach(db, actor)
    clauses = [
        and_(
            FolderGrant.principal_type == GrantPrincipalType.user,
            FolderGrant.principal_ref == str(actor.user.id),
        ),
        and_(
            FolderGrant.principal_type == GrantPrincipalType.workspace,
            FolderGrant.principal_ref.in_(anc),
        ),
    ]
    if include_all_org:
        clauses.append(FolderGrant.principal_type == GrantPrincipalType.all_org)
    return (
        db.execute(
            select(FolderGrant.id)
            .where(FolderGrant.folder_id.in_(folder_ids), or_(*clauses))
            .limit(1)
        ).first()
        is not None
    )


def _folder_edit_reaches(db: Session, folder_ids, user_id: int) -> bool:
    folder_ids = list(folder_ids)
    if not folder_ids:
        return False
    rows = db.execute(
        select(FolderGrant.principal_type, FolderGrant.principal_ref).where(
            FolderGrant.folder_id.in_(folder_ids),
            FolderGrant.level == GrantLevel.edit,
        )
    ).all()
    if not rows:
        return False
    member_slugs = None
    from app.modules.workspaces import services as ws_services

    for ptype, pref in rows:
        if ptype == GrantPrincipalType.user and pref == str(user_id):
            return True
        if ptype == GrantPrincipalType.workspace and pref:
            if member_slugs is None:
                member_slugs = _user_membership_slugs(db, user_id)
            if member_slugs & set(ws_services.get_descendants_inclusive(db, pref)):
                return True
    return False


def _all_org_folder_ids(db: Session) -> set[int]:
    return set(
        db.execute(
            select(FolderGrant.folder_id).where(
                FolderGrant.principal_type == GrantPrincipalType.all_org
            )
        ).scalars()
    )


def _folders_view_reachable_ids(
    db: Session, reach: set[str], user_id: int
) -> set[int]:
    return set(
        db.execute(
            select(FolderGrant.folder_id).where(
                or_(
                    FolderGrant.principal_type == GrantPrincipalType.all_org,
                    and_(
                        FolderGrant.principal_type == GrantPrincipalType.user,
                        FolderGrant.principal_ref == str(user_id),
                    ),
                    and_(
                        FolderGrant.principal_type == GrantPrincipalType.workspace,
                        FolderGrant.principal_ref.in_(reach or {""}),
                    ),
                )
            )
        ).scalars()
    )


def _report_ids_in_folders(db: Session, folder_ids) -> set[int]:
    folder_ids = list(folder_ids)
    if not folder_ids:
        return set()
    from app.modules.mounts.models import ReportMount

    return set(
        db.execute(
            select(ReportMount.report_id).where(
                ReportMount.folder_id.in_(folder_ids)
            )
        ).scalars()
    )


def user_has_container_grant_on_board(
    db: Session, user_id: int, workspace_slug: str
) -> bool:
    """비멤버가 이 게시판을 *브라우즈* 할 자격이 있나(진입 허용 판정).

    게시판 통째 공유(BoardGrant) 또는 이 게시판 폴더의 폴더 공유(FolderGrant)가
    이 사용자에게 멤버십/개인 기준으로 도달하면 True. 개별 콘텐츠 grant 만으로는
    게시판 전체 브라우즈를 열지 않는다(그건 직접 링크/검색 경로). all_org 공개는
    _workspace_has_public_content 에서 이미 처리하므로 여기선 제외한다."""
    from app.modules.folders.models import Folder

    reach = membership_reach_slugs(db, user_id) or {""}
    uid = str(user_id)
    board_match = or_(
        and_(
            BoardGrant.principal_type == GrantPrincipalType.user,
            BoardGrant.principal_ref == uid,
        ),
        and_(
            BoardGrant.principal_type == GrantPrincipalType.workspace,
            BoardGrant.principal_ref.in_(reach),
        ),
    )
    if (
        db.execute(
            select(BoardGrant.id)
            .where(BoardGrant.board_slug == workspace_slug, board_match)
            .limit(1)
        ).first()
        is not None
    ):
        return True
    folder_match = or_(
        and_(
            FolderGrant.principal_type == GrantPrincipalType.user,
            FolderGrant.principal_ref == uid,
        ),
        and_(
            FolderGrant.principal_type == GrantPrincipalType.workspace,
            FolderGrant.principal_ref.in_(reach),
        ),
    )
    return (
        db.execute(
            select(FolderGrant.id)
            .join(Folder, Folder.id == FolderGrant.folder_id)
            .where(Folder.workspace_slug == workspace_slug, folder_match)
            .limit(1)
        ).first()
        is not None
    )


# --------------------------------------------------------------------------- #
# 컨테이너(게시판 ∪ 폴더) 통합 — 콘텐츠가 놓인 게시판/폴더 grant 합산.
# --------------------------------------------------------------------------- #
def _container_has_all_org(
    db: Session, content_type: GrantContentType, content_id: int
) -> bool:
    if board_has_all_org(db, _content_board_slugs(db, content_type, content_id)):
        return True
    return folder_has_all_org(db, _content_folder_ids(db, content_type, content_id))


def _container_view_reaches(
    db: Session, content_type: GrantContentType, content_id: int, actor, *, include_all_org: bool
) -> bool:
    if _board_view_reaches(
        db, _content_board_slugs(db, content_type, content_id), actor,
        include_all_org=include_all_org,
    ):
        return True
    return _folder_view_reaches(
        db, _content_folder_ids(db, content_type, content_id), actor,
        include_all_org=include_all_org,
    )


def _container_edit_reaches(
    db: Session, content_type: GrantContentType, content_id: int, user_id: int
) -> bool:
    if _board_edit_reaches(
        db, _content_board_slugs(db, content_type, content_id), user_id
    ):
        return True
    return _folder_edit_reaches(
        db, _content_folder_ids(db, content_type, content_id), user_id
    )


# --------------------------------------------------------------------------- #
# 통합 can_view / can_edit (owner·sys_admin·virtual·grant 종합)
# --------------------------------------------------------------------------- #
def can_view(
    db: Session,
    actor,
    content_type: GrantContentType,
    content_id: int,
    owner_user_id: Optional[int],
) -> bool:
    """actor 가 이 콘텐츠를 읽을 수 있나. actor 는 CurrentUser 덕타이핑
    (.user.id / .user.is_system_admin / .workspace.virtual / .public_viewer /
    .workspace.slug)."""
    # 비멤버(public_viewer) — 소유·역할이 아니라 *명시적 공유로만* 본다:
    #   전체공개(all_org) ∪ 사용자 grant ∪ 게시판/폴더 단위 공유(부서 하향 도달).
    # ⚠ 게시(mount) 가 자동 생성하는 부서 content grant(workspace=게시판)는 비멤버
    #   가시성에 *넣지 않는다*. 안 그러면 상위 게시판에 게시된 글이 그 부서 트리의
    #   하위 계정에게 통째로 새어, 공유 안 한 글까지 보이게 된다(실제 발생 버그).
    #   게시판/폴더를 명시적으로 공유(BoardGrant/FolderGrant)했을 때만 그 게시판
    #   콘텐츠가 비멤버에게 열린다. 멤버 경로(아래)는 기존대로 부서 grant 포함.
    if getattr(actor, "public_viewer", False):
        if has_all_org_grant(db, content_type, content_id):
            return True
        if has_user_grant(db, content_type, content_id, actor.user.id):
            return True
        return _container_view_reaches(
            db, content_type, content_id, actor, include_all_org=True
        )
    if owner_user_id is not None and owner_user_id == actor.user.id:
        return True
    if getattr(actor.user, "is_system_admin", False):
        return True
    if getattr(actor.workspace, "virtual", False):
        return True
    if has_all_org_grant(db, content_type, content_id):
        return True
    if has_user_grant(db, content_type, content_id, actor.user.id):
        return True
    if _workspace_grant_slugs(db, content_type, content_id) & _actor_view_reach(
        db, actor
    ):
        return True
    # 게시판/폴더 통째 공유 경유.
    return _container_view_reaches(
        db, content_type, content_id, actor, include_all_org=True
    )


def is_member_view(
    db: Session,
    actor,
    content_type: GrantContentType,
    content_id: int,
    owner_user_id: Optional[int],
) -> bool:
    """멤버 경로(소유·user·부서 grant)로 보이나 — all_org 공개 경로 제외.
    공개-only 열람자 판정(읽기전용 배너·곁다리 차단)에 쓴다."""
    if getattr(actor, "public_viewer", False):
        return False
    if owner_user_id is not None and owner_user_id == actor.user.id:
        return True
    if getattr(actor.user, "is_system_admin", False):
        return True
    if getattr(actor.workspace, "virtual", False):
        return True
    if has_user_grant(db, content_type, content_id, actor.user.id):
        return True
    if reachable_workspace_view(
        db, content_type, content_id, actor.workspace.slug
    ):
        return True
    # 게시판/폴더 통째 공유의 멤버 경로(user/부서 grant) — all_org 제외.
    return _container_view_reaches(
        db, content_type, content_id, actor, include_all_org=False
    )


def is_public_only_viewer(
    db: Session,
    actor,
    content_type: GrantContentType,
    content_id: int,
    owner_user_id: Optional[int],
) -> bool:
    """공개(all_org) 경로로만 보이는 상태 — 멤버 경로로는 안 보이는데 공개라서 보임
    (콘텐츠 all_org 또는 게시판 all_org)."""
    if is_member_view(db, actor, content_type, content_id, owner_user_id):
        return False
    return has_all_org_grant(
        db, content_type, content_id
    ) or _container_has_all_org(db, content_type, content_id)


def can_edit_grant(
    db: Session,
    user,
    content_type: GrantContentType,
    content_id: int,
    owner_user_id: Optional[int],
) -> bool:
    """grant 기반 편집 가능 여부(sys_admin·owner·user edit·부서 edit 하위도달).
    보고서의 author_lock veto 는 호출부(permissions.can_edit)가 먼저 처리한다."""
    if getattr(user, "is_system_admin", False):
        return True
    if owner_user_id is not None and owner_user_id == user.id:
        return True
    if has_user_grant(db, content_type, content_id, user.id, level=GrantLevel.edit):
        return True
    if reachable_workspace_edit(db, content_type, content_id, user.id):
        return True
    # 게시판/폴더 통째 공유의 편집 권한.
    if _container_edit_reaches(db, content_type, content_id, user.id):
        return True
    # 게시판 매니저 편집(작성자+게시판 매니저 정책).
    return _manager_edit_reaches(db, content_type, content_id, user.id)


def _manager_edit_reaches(
    db: Session, content_type: GrantContentType, content_id: int, user_id: int
) -> bool:
    """workspace_manager(edit) grant 가 user 에게 도달하나 — user 가 그 부서의
    매니저(역할 해석상 매니저, 조상 매니저 포함)인지로 판정."""
    slugs = {
        s
        for s in db.execute(
            select(ContentGrant.principal_ref).where(
                ContentGrant.content_type == content_type,
                ContentGrant.content_id == content_id,
                ContentGrant.principal_type == GrantPrincipalType.workspace_manager,
                ContentGrant.level == GrantLevel.edit,
            )
        ).scalars()
        if s
    }
    if not slugs:
        return False
    from app.modules.users.models import Role
    from app.shared.auth import _resolve_role

    for slug in slugs:
        if _resolve_role(db, user_id, slug) == Role.manager:
            return True
    return False


# --------------------------------------------------------------------------- #
# 대량 가시성 id 집합 (목록·그래프용)
# --------------------------------------------------------------------------- #
# --------------------------------------------------------------------------- #
# grant 생성/삭제 (mount·생성 자동 grant + shares 엔드포인트)
# --------------------------------------------------------------------------- #
def list_grants(
    db: Session, content_type: GrantContentType, content_id: int
) -> list[ContentGrant]:
    return list(
        db.execute(
            select(ContentGrant)
            .where(
                ContentGrant.content_type == content_type,
                ContentGrant.content_id == content_id,
            )
            .order_by(ContentGrant.id)
        ).scalars()
    )


def _find_grant(
    db: Session,
    content_type: GrantContentType,
    content_id: int,
    principal_type: GrantPrincipalType,
    principal_ref: Optional[str],
) -> Optional[ContentGrant]:
    q = select(ContentGrant).where(
        ContentGrant.content_type == content_type,
        ContentGrant.content_id == content_id,
        ContentGrant.principal_type == principal_type,
    )
    if principal_type == GrantPrincipalType.all_org:
        q = q.where(ContentGrant.principal_ref.is_(None))
    else:
        q = q.where(ContentGrant.principal_ref == principal_ref)
    return db.execute(q.limit(1)).scalar_one_or_none()


def upsert_grant(
    db: Session,
    content_type: GrantContentType,
    content_id: int,
    principal_type: GrantPrincipalType,
    principal_ref: Optional[str],
    level: GrantLevel,
    *,
    created_by_user_id: Optional[int] = None,
) -> ContentGrant:
    """대상별 grant 추가/갱신. all_org 는 항상 view 로 강제. 같은 대상이 이미
    있으면 level 만 갱신(중복 행 안 만듦)."""
    if principal_type == GrantPrincipalType.all_org:
        principal_ref = None
        level = GrantLevel.view
    existing = _find_grant(db, content_type, content_id, principal_type, principal_ref)
    if existing is not None:
        existing.level = level
        db.flush()
        return existing
    grant = ContentGrant(
        content_type=content_type,
        content_id=content_id,
        principal_type=principal_type,
        principal_ref=principal_ref,
        level=level,
        created_by_user_id=created_by_user_id,
    )
    db.add(grant)
    db.flush()
    return grant


def ensure_workspace_grant(
    db: Session,
    content_type: GrantContentType,
    content_id: int,
    workspace_slug: str,
    level: GrantLevel = GrantLevel.view,
    *,
    created_by_user_id: Optional[int] = None,
) -> None:
    """부서 grant 가 없으면 만든다(있으면 그대로 — 기존 level 안 낮춤). mount·
    종합보고 생성 시 자동 view grant 부여에 쓴다."""
    existing = _find_grant(
        db, content_type, content_id, GrantPrincipalType.workspace, workspace_slug
    )
    if existing is not None:
        return
    db.add(
        ContentGrant(
            content_type=content_type,
            content_id=content_id,
            principal_type=GrantPrincipalType.workspace,
            principal_ref=workspace_slug,
            level=level,
            created_by_user_id=created_by_user_id,
        )
    )
    db.flush()


def remove_workspace_grant(
    db: Session,
    content_type: GrantContentType,
    content_id: int,
    workspace_slug: str,
) -> None:
    """이 부서 grant 제거(unmount 시 배치 해제). 다른 대상 grant 는 유지."""
    grant = _find_grant(
        db, content_type, content_id, GrantPrincipalType.workspace, workspace_slug
    )
    if grant is not None:
        db.delete(grant)
        db.flush()


def remove_principal_grant(
    db: Session,
    content_type: GrantContentType,
    content_id: int,
    principal_type: GrantPrincipalType,
    principal_ref: Optional[str],
) -> None:
    """특정 대상(principal) grant 제거 — 예: workspace_manager(매니저 편집) 해제."""
    grant = _find_grant(db, content_type, content_id, principal_type, principal_ref)
    if grant is not None:
        db.delete(grant)
        db.flush()


def delete_grant(db: Session, grant: ContentGrant) -> None:
    db.delete(grant)
    db.flush()


def delete_all_for_content(
    db: Session, content_type: GrantContentType, content_id: int
) -> None:
    """이 콘텐츠의 모든 content_grant 제거 — 보고서/종합보고 삭제 시 고아 행
    방지(content_grant 는 polymorphic 이라 FK CASCADE 가 없다)."""
    db.execute(
        sa_delete(ContentGrant).where(
            ContentGrant.content_type == content_type,
            ContentGrant.content_id == content_id,
        )
    )
    db.flush()


# --------------------------------------------------------------------------- #
# 게시판(board) grant CRUD — /api/workspaces/{slug}/shares
# --------------------------------------------------------------------------- #
def list_board_grants(db: Session, board_slug: str) -> list[BoardGrant]:
    return list(
        db.execute(
            select(BoardGrant)
            .where(BoardGrant.board_slug == board_slug)
            .order_by(BoardGrant.id)
        ).scalars()
    )


def _find_board_grant(
    db: Session,
    board_slug: str,
    principal_type: GrantPrincipalType,
    principal_ref: Optional[str],
) -> Optional[BoardGrant]:
    q = select(BoardGrant).where(
        BoardGrant.board_slug == board_slug,
        BoardGrant.principal_type == principal_type,
    )
    if principal_type == GrantPrincipalType.all_org:
        q = q.where(BoardGrant.principal_ref.is_(None))
    else:
        q = q.where(BoardGrant.principal_ref == principal_ref)
    return db.execute(q.limit(1)).scalar_one_or_none()


def upsert_board_grant(
    db: Session,
    board_slug: str,
    principal_type: GrantPrincipalType,
    principal_ref: Optional[str],
    level: GrantLevel,
    *,
    created_by_user_id: Optional[int] = None,
) -> BoardGrant:
    if principal_type == GrantPrincipalType.all_org:
        principal_ref = None
        level = GrantLevel.view
    existing = _find_board_grant(db, board_slug, principal_type, principal_ref)
    if existing is not None:
        existing.level = level
        db.flush()
        return existing
    grant = BoardGrant(
        board_slug=board_slug,
        principal_type=principal_type,
        principal_ref=principal_ref,
        level=level,
        created_by_user_id=created_by_user_id,
    )
    db.add(grant)
    db.flush()
    return grant


def delete_board_grant(db: Session, grant: BoardGrant) -> None:
    db.delete(grant)
    db.flush()


# --------------------------------------------------------------------------- #
# 폴더(folder) grant CRUD — /api/folders/{id}/shares
# --------------------------------------------------------------------------- #
def list_folder_grants(db: Session, folder_id: int) -> list[FolderGrant]:
    return list(
        db.execute(
            select(FolderGrant)
            .where(FolderGrant.folder_id == folder_id)
            .order_by(FolderGrant.id)
        ).scalars()
    )


def _find_folder_grant(
    db: Session,
    folder_id: int,
    principal_type: GrantPrincipalType,
    principal_ref: Optional[str],
) -> Optional[FolderGrant]:
    q = select(FolderGrant).where(
        FolderGrant.folder_id == folder_id,
        FolderGrant.principal_type == principal_type,
    )
    if principal_type == GrantPrincipalType.all_org:
        q = q.where(FolderGrant.principal_ref.is_(None))
    else:
        q = q.where(FolderGrant.principal_ref == principal_ref)
    return db.execute(q.limit(1)).scalar_one_or_none()


def upsert_folder_grant(
    db: Session,
    folder_id: int,
    principal_type: GrantPrincipalType,
    principal_ref: Optional[str],
    level: GrantLevel,
    *,
    created_by_user_id: Optional[int] = None,
) -> FolderGrant:
    if principal_type == GrantPrincipalType.all_org:
        principal_ref = None
        level = GrantLevel.view
    existing = _find_folder_grant(db, folder_id, principal_type, principal_ref)
    if existing is not None:
        existing.level = level
        db.flush()
        return existing
    grant = FolderGrant(
        folder_id=folder_id,
        principal_type=principal_type,
        principal_ref=principal_ref,
        level=level,
        created_by_user_id=created_by_user_id,
    )
    db.add(grant)
    db.flush()
    return grant


def delete_folder_grant(db: Session, grant: FolderGrant) -> None:
    db.delete(grant)
    db.flush()


def _principal_label(
    db: Session, principal_type: GrantPrincipalType, principal_ref: Optional[str]
) -> str:
    if principal_type == GrantPrincipalType.all_org:
        return "전체 공개"
    if principal_type == GrantPrincipalType.workspace:
        from app.modules.workspaces.models import Workspace

        ws = db.get(Workspace, principal_ref)
        return ws.name if ws else (principal_ref or "")
    if principal_type == GrantPrincipalType.workspace_manager:
        from app.modules.workspaces.models import Workspace

        ws = db.get(Workspace, principal_ref)
        return f"{ws.name if ws else principal_ref} 매니저"
    from app.modules.users.models import User

    try:
        u = db.get(User, int(principal_ref))
    except (TypeError, ValueError):
        u = None
    return u.name if u else (principal_ref or "")


def _summary(g) -> dict:
    return {
        "principal_type": getattr(g.principal_type, "value", g.principal_type),
        "level": getattr(g.level, "value", g.level),
    }


def folder_share_summaries(db: Session, folder_ids) -> dict[int, list[dict]]:
    """folder_id → [{principal_type, principal_label, level}] (목록 뱃지/호버용)."""
    folder_ids = list(folder_ids)
    if not folder_ids:
        return {}
    out: dict[int, list[dict]] = {}
    rows = db.execute(
        select(FolderGrant)
        .where(FolderGrant.folder_id.in_(folder_ids))
        .order_by(FolderGrant.id)
    ).scalars()
    for g in rows:
        item = _summary(g)
        item["principal_label"] = _principal_label(
            db, g.principal_type, g.principal_ref
        )
        out.setdefault(g.folder_id, []).append(item)
    return out


def content_share_summaries(
    db: Session, content_type: GrantContentType, content_ids
) -> dict[int, list[dict]]:
    """content_id → [{principal_type, principal_label, level}] — 목록 뱃지/호버용
    (콘텐츠 자체 grant 만; 게시판/폴더 통째 공유는 그쪽 뱃지에서 본다)."""
    content_ids = list(content_ids)
    if not content_ids:
        return {}
    out: dict[int, list[dict]] = {}
    rows = db.execute(
        select(ContentGrant)
        .where(
            ContentGrant.content_type == content_type,
            ContentGrant.content_id.in_(content_ids),
        )
        .order_by(ContentGrant.id)
    ).scalars()
    for g in rows:
        item = _summary(g)
        item["principal_label"] = _principal_label(
            db, g.principal_type, g.principal_ref
        )
        out.setdefault(g.content_id, []).append(item)
    return out


def all_org_ids(db: Session, content_type: GrantContentType) -> set[int]:
    return set(
        db.execute(
            select(ContentGrant.content_id).where(
                ContentGrant.content_type == content_type,
                ContentGrant.principal_type == GrantPrincipalType.all_org,
            )
        ).scalars()
    )


def _content_ids_on_boards(
    db: Session, content_type: GrantContentType, board_slugs
) -> set[int]:
    """주어진 게시판들에 속한 content_id 집합(보고서=mount, 종합보고=home)."""
    board_slugs = list(board_slugs)
    if not board_slugs:
        return set()
    if content_type == GrantContentType.report:
        from app.modules.mounts.models import ReportMount

        return set(
            db.execute(
                select(ReportMount.report_id).where(
                    ReportMount.workspace_slug.in_(board_slugs)
                )
            ).scalars()
        )
    from app.modules.composites.models import CompositeReport

    return set(
        db.execute(
            select(CompositeReport.id).where(
                CompositeReport.workspace_slug.in_(board_slugs)
            )
        ).scalars()
    )


def _all_org_board_slugs(db: Session) -> set[str]:
    return set(
        db.execute(
            select(BoardGrant.board_slug).where(
                BoardGrant.principal_type == GrantPrincipalType.all_org
            )
        ).scalars()
    )


def public_ids(db: Session, content_type: GrantContentType) -> set[int]:
    """전체 공개(all_org)인 content_id 집합 — 콘텐츠 자체 all_org ∪ 전체공개
    게시판/폴더에 속한 콘텐츠. 목록의 '지구본'·공개 탐색에 쓴다."""
    ids = all_org_ids(db, content_type) | _content_ids_on_boards(
        db, content_type, _all_org_board_slugs(db)
    )
    if content_type == GrantContentType.report:
        ids |= _report_ids_in_folders(db, _all_org_folder_ids(db))
    return ids


def visible_ids(
    db: Session, actor, content_type: GrantContentType
) -> Optional[set[int]]:
    """actor 가 볼 수 있는 content_id 집합. None = 무스코프(virtual 전체 가시).
    owner 분은 호출부에서 합친다(여기선 grant 분만)."""
    if getattr(actor.workspace, "virtual", False):
        return None
    is_nonmember = getattr(actor, "public_viewer", False)
    # 멤버는 active-ws 조상, 비멤버는 멤버십 기반(헤더 위조 차단).
    anc = _actor_view_reach(db, actor)
    ids: set[int] = set(all_org_ids(db, content_type))
    # user grant
    ids |= set(
        db.execute(
            select(ContentGrant.content_id).where(
                ContentGrant.content_type == content_type,
                ContentGrant.principal_type == GrantPrincipalType.user,
                ContentGrant.principal_ref == str(actor.user.id),
            )
        ).scalars()
    )
    # workspace content grant 도달(하위 상속) — 게시(mount) 자동 grant 포함이라
    # *멤버 전용*. 비멤버는 이 경로를 빼서 상위 게시판 게시글이 하위 계정에
    # 통째로 새는 것을 막는다(비멤버는 명시적 게시판/폴더 공유로만 본다).
    if not is_nonmember:
        ids |= set(
            db.execute(
                select(ContentGrant.content_id).where(
                    ContentGrant.content_type == content_type,
                    ContentGrant.principal_type == GrantPrincipalType.workspace,
                    ContentGrant.principal_ref.in_(anc),
                )
            ).scalars()
        )
    # 게시판 통째 공유로 도달하는 게시판의 콘텐츠.
    ids |= _content_ids_on_boards(
        db, content_type, _boards_view_reachable_slugs(db, anc, actor.user.id)
    )
    # 폴더 통째 공유로 도달하는 폴더의 보고서(종합보고는 폴더 없음).
    if content_type == GrantContentType.report:
        ids |= _report_ids_in_folders(
            db, _folders_view_reachable_ids(db, anc, actor.user.id)
        )
    return ids


def visible_ids_for_user(
    db: Session, user_id: int, content_type: GrantContentType
) -> set[int]:
    """actor(CurrentUser) 없이 user_id 만으로 계산한 *비멤버* 가시 content_id 집합
    — active workspace 와 무관(폴더 카운트 등). visible_ids 의 비멤버 분기와 동치:
    전체공개 ∪ 사용자 grant ∪ 게시판/폴더 단위 공유만. 게시(mount) 자동 부서 grant
    는 제외(상위 게시판 게시글이 하위 계정에 새는 것 방지)."""
    reach = membership_reach_slugs(db, user_id)
    ids: set[int] = set(all_org_ids(db, content_type))
    ids |= set(
        db.execute(
            select(ContentGrant.content_id).where(
                ContentGrant.content_type == content_type,
                ContentGrant.principal_type == GrantPrincipalType.user,
                ContentGrant.principal_ref == str(user_id),
            )
        ).scalars()
    )
    ids |= _content_ids_on_boards(
        db, content_type, _boards_view_reachable_slugs(db, reach, user_id)
    )
    if content_type == GrantContentType.report:
        ids |= _report_ids_in_folders(
            db, _folders_view_reachable_ids(db, reach, user_id)
        )
    return ids
