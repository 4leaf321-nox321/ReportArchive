"""Workspace tree services.

Tree traversal is done in Python (org chart is small enough that recursive
CTEs aren't worth the complexity).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.reports.models import Report
from app.modules.templates.models import Template
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace, WorkspaceKind, WorkspaceStatus
from app.modules.workspaces.schemas import (
    TFWorkspaceCreate,
    WorkspaceBulkCreate,
    WorkspaceCreate,
    WorkspaceUpdate,
)


# Palette for auto-assigned workspace colors. Tuned to be visually distinct
# at the dot/badge sizes the UI uses (Tailwind 500-shade hexes). The
# algorithm cycles through this palette so siblings always land on
# different slots — see compute_workspace_colors below.
_COLOR_PALETTE: tuple[str, ...] = (
    "#3b82f6",  # blue
    "#10b981",  # emerald
    "#f59e0b",  # amber
    "#a855f7",  # purple
    "#ef4444",  # red
    "#06b6d4",  # cyan
    "#84cc16",  # lime
    "#ec4899",  # pink
    "#6366f1",  # indigo
    "#14b8a6",  # teal
    "#f97316",  # orange
    "#8b5cf6",  # violet
)
_VIRTUAL_COLOR = "#64748b"  # slate — used for virtual aggregate workspaces
_TF_COLOR = "#8b5cf6"  # violet — TF 워크스페이스(트리 밖) 고정 색


def compute_workspace_colors(workspaces: list[Workspace]) -> dict[str, str]:
    """Returns slug → color, derived purely from the tree.

    Goal: any two **siblings** (children of the same parent) land on
    different palette slots so a user scanning dept dots can tell same-
    parent peers apart. Cross-subtree collisions are accepted — the
    palette is small and global uniqueness in a deep tree isn't feasible.

    Algorithm: each node carries a "color index" into `_COLOR_PALETTE`.
    A child's index is `parent_index + 1 + sibling_pos` (mod palette size),
    where sibling_pos comes from a (sort_order, slug) sort. Roots
    themselves are ordered by (created_at, slug) so adding a new root
    appends to the end without reshuffling existing slots.

    Virtuals (e.g. `_global`) and orphans always get the neutral slate.
    """
    children_of: dict[Optional[str], list[Workspace]] = {}
    for w in workspaces:
        children_of.setdefault(w.parent_slug, []).append(w)
    # Stable sibling order so palette slots don't shuffle on save.
    for siblings in children_of.values():
        siblings.sort(key=lambda w: (w.sort_order, w.slug))

    out: dict[str, str] = {}
    n = len(_COLOR_PALETTE)

    def walk(node: Workspace, idx: int) -> None:
        out[node.slug] = _COLOR_PALETTE[idx % n]
        for i, child in enumerate(children_of.get(node.slug, [])):
            if child.virtual:
                out[child.slug] = _VIRTUAL_COLOR
                continue
            walk(child, idx + 1 + i)

    # TF(kind=tf)는 parent_slug=NULL 이라 자칫 org 루트로 오인돼 팔레트 순번을
    # 흔든다. 트리 밖 별도 평면이므로 색 계산에서 제외하고 아래서 고정색을 준다.
    real_roots = sorted(
        (
            w
            for w in workspaces
            if w.parent_slug is None
            and not w.virtual
            and w.kind != WorkspaceKind.tf
        ),
        key=lambda w: (w.created_at, w.slug),
    )
    for i, r in enumerate(real_roots):
        walk(r, i)

    # Anything we didn't reach (virtual roots, TF, orphans whose parent was
    # deleted) gets a fixed color so the dot still renders.
    for w in workspaces:
        if w.slug not in out:
            out[w.slug] = _TF_COLOR if w.kind == WorkspaceKind.tf else _VIRTUAL_COLOR
    return out


def recompute_workspace_colors(db: Session) -> None:
    """Recompute and persist colors for every workspace.

    Cheap (org has tens of rows at most) and avoids the bookkeeping of
    tracking which subtrees a mutation affected. Caller is responsible for
    committing the surrounding transaction.
    """
    rows = list(db.execute(select(Workspace)).scalars())
    colors = compute_workspace_colors(rows)
    for w in rows:
        new = colors.get(w.slug, _VIRTUAL_COLOR)
        if w.color != new:
            w.color = new


def list_workspaces(db: Session) -> list[Workspace]:
    return list(
        db.execute(select(Workspace).order_by(Workspace.sort_order, Workspace.slug)).scalars()
    )


def get_descendants_inclusive(db: Session, slug: str) -> list[str]:
    """Returns slug + all descendant slugs (depth-first)."""
    all_ws = list_workspaces(db)
    children_of: dict[str | None, list[str]] = {}
    for w in all_ws:
        children_of.setdefault(w.parent_slug, []).append(w.slug)

    result: list[str] = []
    stack = [slug]
    while stack:
        cur = stack.pop()
        result.append(cur)
        for child in children_of.get(cur, []):
            stack.append(child)
    return result


def get_ancestors(db: Session, slug: str) -> list[Workspace]:
    """Ancestors from root to direct parent (excludes self)."""
    path: list[Workspace] = []
    cur: Optional[str] = slug
    seen: set[str] = set()
    while cur and cur not in seen:
        seen.add(cur)
        ws = db.get(Workspace, cur)
        if not ws or ws.parent_slug is None:
            break
        parent = db.get(Workspace, ws.parent_slug)
        if not parent:
            break
        path.insert(0, parent)
        # 다음 반복에서 parent 의 부모를 보도록 cur 를 parent 로 옮긴다. 과거엔
        # parent.parent_slug 로 점프해 한 단계씩 건너뛰는 버그가 있었다(3단계
        # 이상 트리에서 조부모가 누락 → 하위 상속 가시성 깨짐).
        cur = parent.slug
    return path


# --------------------------------------------------------------------------- #
# Mutations
# --------------------------------------------------------------------------- #
def create_workspace(db: Session, payload: WorkspaceCreate) -> Workspace:
    if db.get(Workspace, payload.slug):
        raise ValueError(f"이미 존재하는 부서 슬러그입니다: {payload.slug}")
    if payload.parent_slug:
        parent = db.get(Workspace, payload.parent_slug)
        if not parent:
            raise ValueError(f"상위 부서가 없습니다: {payload.parent_slug}")
        if parent.virtual:
            raise ValueError("가상 부서 아래에 자식을 만들 수 없습니다.")

    ws = Workspace(
        slug=payload.slug,
        name=payload.name,
        description=payload.description,
        parent_slug=payload.parent_slug,
        # Placeholder — overwritten by recompute_workspace_colors below. The
        # color column is auto-managed; clients can't set it.
        color=_VIRTUAL_COLOR,
        virtual=False,
        sort_order=payload.sort_order,
    )
    db.add(ws)
    db.flush()  # assign created_at + make the row visible to the recompute
    recompute_workspace_colors(db)
    db.commit()
    db.refresh(ws)
    return ws


def _validate_parent_change(
    db: Session, ws: Workspace, new_parent_slug: Optional[str]
) -> None:
    """Validates a parent reassignment. Raises ValueError on:
      - self-parent
      - parent doesn't exist
      - parent is virtual
      - parent is a descendant of `ws` (would create a cycle)
    """
    if new_parent_slug is None:
        return  # promote to root — always safe
    if new_parent_slug == ws.slug:
        raise ValueError("자기 자신을 상위 부서로 지정할 수 없습니다.")
    parent = db.get(Workspace, new_parent_slug)
    if not parent:
        raise ValueError(f"상위 부서가 없습니다: {new_parent_slug}")
    if parent.virtual:
        raise ValueError("가상 부서 아래로 이동할 수 없습니다.")
    descendants = set(get_descendants_inclusive(db, ws.slug))
    if new_parent_slug in descendants:
        raise ValueError(
            "하위 부서 아래로 이동할 수 없습니다 (트리 순환이 발생합니다)."
        )


def update_workspace(db: Session, ws: Workspace, payload: WorkspaceUpdate) -> Workspace:
    fields_set = payload.model_fields_set
    data = payload.model_dump()

    # parent_slug treated specially because `null` is meaningful (= make root).
    # We only touch it if the field was explicitly sent.
    parent_changed = False
    if "parent_slug" in fields_set:
        new_parent = data["parent_slug"]
        if new_parent != ws.parent_slug:
            _validate_parent_change(db, ws, new_parent)
            ws.parent_slug = new_parent
            parent_changed = True

    for key in ("name", "description", "sort_order"):
        if key in fields_set and data[key] is not None:
            setattr(ws, key, data[key])

    # Color is auto-derived from the tree; a parent move can shift this
    # workspace (and any descendant) into a different root's subtree, so
    # recompute whenever the tree shape changed.
    if parent_changed:
        db.flush()
        recompute_workspace_colors(db)

    db.commit()
    db.refresh(ws)
    return ws


def workspace_blockers(db: Session, slug: str) -> dict:
    """Returns dependency counts that prevent deletion. All-zero = safe to drop."""
    children = (
        db.execute(
            select(func.count(Workspace.slug)).where(Workspace.parent_slug == slug)
        ).scalar()
        or 0
    )
    members = (
        db.execute(
            select(func.count(WorkspaceMember.id)).where(
                WorkspaceMember.workspace_slug == slug
            )
        ).scalar()
        or 0
    )
    reports = (
        db.execute(
            select(func.count(Report.id)).where(Report.workspace_slug == slug)
        ).scalar()
        or 0
    )
    templates = (
        db.execute(
            select(func.count(Template.template_id)).where(
                Template.owner_workspace_slugs.contains([slug])
            )
        ).scalar()
        or 0
    )
    return {
        "children": int(children),
        "members": int(members),
        "reports": int(reports),
        "templates": int(templates),
    }


def delete_workspace(db: Session, ws: Workspace) -> None:
    blockers = workspace_blockers(db, ws.slug)
    if any(blockers.values()):
        parts = [f"{k}={v}" for k, v in blockers.items() if v]
        raise ValueError(
            f"부서를 삭제할 수 없습니다 (참조 중: {', '.join(parts)}). 먼저 정리하세요."
        )
    db.delete(ws)
    db.commit()


def _norm_name(s: Optional[str]) -> str:
    """Normalize a workspace name for case-insensitive parent lookup."""
    return (s or "").strip().casefold()


def bulk_create_workspaces(
    db: Session, payload: WorkspaceBulkCreate
) -> list[Workspace]:
    """Create many workspaces in one transaction, resolving parents by name.

    Parent names are matched (trimmed + casefold) against existing non-virtual
    workspaces or against earlier rows in the same batch. Rows whose parent
    isn't yet resolvable are held back and retried — that way the input rows
    don't have to be in topological order. If after a full pass no progress
    was made and rows remain, we raise ValueError listing the orphans.

    Ambiguous parent names (multiple existing depts with the same name) are
    rejected: the operator must rename one before bulk-importing.

    Colors are recomputed once at the end so the whole new subtree picks up
    correct palette slots in a single recompute.
    """
    # name (normalized) → list of existing slugs. Multiple = ambiguous.
    existing_by_name: dict[str, list[str]] = {}
    for w in list_workspaces(db):
        if w.virtual:
            continue
        existing_by_name.setdefault(_norm_name(w.name), []).append(w.slug)

    # Validate names up front.
    items = list(payload.items)
    for idx, item in enumerate(items):
        if not (item.name or "").strip():
            raise ValueError(f"{idx + 1}행: 부서 이름이 비어 있습니다.")

    # Detect duplicates *within the batch* — same name twice in the paste
    # makes parent references ambiguous and is almost certainly a mistake.
    batch_counts: dict[str, int] = {}
    for item in items:
        batch_counts[_norm_name(item.name)] = batch_counts.get(_norm_name(item.name), 0) + 1
    dupes = [n for n, c in batch_counts.items() if c > 1]
    if dupes:
        raise ValueError(
            f"일괄 추가 행 안에 중복된 부서 이름이 있습니다: {dupes}"
        )

    # Resolve + insert in waves. Each pass tries to create any row whose
    # parent is now known; if nothing changed in a pass, the remainder
    # is unresolvable.
    created: list[Workspace] = []
    pending = list(items)
    while pending:
        next_round: list[WorkspaceBulkCreate] = []
        progress = False
        for item in pending:
            parent_raw = (item.parent_name or "").strip()
            parent_slug: Optional[str] = None
            if parent_raw:
                key = _norm_name(parent_raw)
                hits = existing_by_name.get(key, [])
                if len(hits) > 1:
                    raise ValueError(
                        f"'{item.name}'의 상위 부서 이름이 모호합니다: "
                        f"'{parent_raw}' (기존에 같은 이름 {len(hits)}개)"
                    )
                if hits:
                    parent_slug = hits[0]
                else:
                    # Parent might still be in the pending pile — defer.
                    next_round.append(item)
                    continue

            slug = str(uuid.uuid4())
            ws = Workspace(
                slug=slug,
                name=item.name.strip(),
                description="",
                parent_slug=parent_slug,
                color=_VIRTUAL_COLOR,  # placeholder; recomputed below
                virtual=False,
                sort_order=0,
            )
            db.add(ws)
            db.flush()  # populate created_at + make visible to next lookups
            existing_by_name.setdefault(_norm_name(ws.name), []).append(slug)
            created.append(ws)
            progress = True
        if not progress:
            orphans = [i.name for i in next_round]
            raise ValueError(
                f"상위 부서를 찾을 수 없는 항목: {orphans}. 기존 부서명과 "
                "정확히 일치해야 하며, 같은 일괄 안에서 참조하려면 부모가 "
                "어딘가에 존재해야 합니다."
            )
        pending = next_round

    recompute_workspace_colors(db)
    db.commit()
    for ws in created:
        db.refresh(ws)
    return created


# --------------------------------------------------------------------------- #
# Personal workspace provisioning
# --------------------------------------------------------------------------- #
def ensure_personal_workspace(db: Session, user: User) -> Workspace:
    """Idempotent: guarantee `personal-{user.id}` workspace + the owner's
    admin membership on it both exist. Returns the workspace row.

    Background — every new report is born in the creator's personal
    workspace (`reports/routes.py:139`), so a missing personal workspace
    surfaces as an FK violation on first report creation. This is the
    runtime-equivalent of the Phase 0 migration's backfill (matches its
    column shape: name="{user.name or email-local} (개인)", color="#64748b",
    description="개인 작업공간").

    Callers: `/auth/signup`, `/auth/register`, `seed_initial_data.py` —
    every site that creates a User must call this before commit so the
    user can immediately create reports on their personal space.

    Safe to call on existing users: returns the existing row, doesn't
    duplicate the membership. Requires `user.id` to be populated
    (caller's responsibility — flush before invoking).
    """
    if user.id is None:
        raise ValueError(
            "ensure_personal_workspace 호출 전 db.flush() 로 user.id 가 채워져 있어야 합니다."
        )

    slug = f"personal-{user.id}"
    ws = db.get(Workspace, slug)
    if ws is None:
        # Match the migration's name format so users created at different
        # times look consistent in admin UIs.
        local_part = (user.email or "").split("@", 1)[0]
        display_base = (user.name or "").strip() or local_part or f"user{user.id}"
        ws = Workspace(
            slug=slug,
            name=f"{display_base} (개인)",
            description="개인 작업공간",
            kind=WorkspaceKind.personal,
            personal_owner_user_id=user.id,
            virtual=False,
            sort_order=0,
            color="#64748b",
        )
        db.add(ws)
        db.flush()

    # Self-admin membership: without this row the workspace-permission
    # check rejects the owner from reading/editing their own reports.
    existing_membership = db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.user_id == user.id,
            WorkspaceMember.workspace_slug == slug,
        )
    ).scalar_one_or_none()
    if existing_membership is None:
        db.add(
            WorkspaceMember(
                user_id=user.id,
                workspace_slug=slug,
                role=Role.manager,
            )
        )
        db.flush()

    return ws


# --------------------------------------------------------------------------- #
# TF(태스크포스) — 트리 밖 한시 조직 (TF조직_설계.md)
# --------------------------------------------------------------------------- #
def user_is_lead(db: Session, user: User) -> bool:
    """TF 를 개설할 수 있는 '보직장 이상'인가 — 시스템관리자 OR **org 부서**의
    매니저(role=manager). ⚠ personal 워크스페이스는 모든 사용자가 자기 것의
    매니저이므로(ensure_personal_workspace) 반드시 제외해야 한다. 안 그러면
    전 사용자가 보직장이 되어 개설 게이트가 무력화된다. TF 매니저 자격도
    제외 — '보직장' 신호는 공식 조직(org)에서만."""
    if user.is_system_admin:
        return True
    row = db.execute(
        select(WorkspaceMember.id)
        .join(Workspace, Workspace.slug == WorkspaceMember.workspace_slug)
        .where(
            WorkspaceMember.user_id == user.id,
            WorkspaceMember.role == Role.manager,
            Workspace.kind == WorkspaceKind.org,
        )
        .limit(1)
    ).first()
    return row is not None


def _new_tf_slug(db: Session) -> str:
    """`tf-<hex>` 형태의 충돌 없는 슬러그. URL/FK 에 그대로 쓰인다."""
    for _ in range(10):
        slug = f"tf-{uuid.uuid4().hex[:12]}"
        if db.get(Workspace, slug) is None:
            return slug
    raise ValueError("TF 슬러그 생성에 실패했습니다. 다시 시도하세요.")


def create_tf_workspace(
    db: Session, payload: TFWorkspaceCreate, creator: User
) -> tuple[Workspace, list[str]]:
    """TF 개설. 트리 밖(parent_slug=NULL), 개설자=매니저. member_emails 의
    기존 사용자를 role=user 로 차출(부서 무관). 반환: (TF, 추가 실패한 이메일들).

    색 계산은 recompute 가 TF 를 _TF_COLOR 로 고정하지만, TF 단독 생성으로 org
    색을 흔들지 않도록 compute_workspace_colors 가 이미 tf 를 real_roots 에서
    제외한다."""
    ws = Workspace(
        slug=_new_tf_slug(db),
        name=payload.name.strip(),
        description=payload.description,
        parent_slug=None,  # 트리 밖 — 상속 없음
        kind=WorkspaceKind.tf,
        status=WorkspaceStatus.active,
        color=_TF_COLOR,
        virtual=False,
        sort_order=0,
        created_by_user_id=creator.id,
    )
    db.add(ws)
    db.flush()

    # 개설자 = 매니저
    db.add(
        WorkspaceMember(
            user_id=creator.id, workspace_slug=ws.slug, role=Role.manager
        )
    )

    # 차출 멤버(부서 무관). 미가입 이메일은 건너뛰고 누락분을 보고.
    missing: list[str] = []
    seen: set[int] = {creator.id}
    for email in payload.member_emails:
        email = (email or "").strip()
        if not email:
            continue
        member_user = db.execute(
            select(User).where(User.email == email)
        ).scalar_one_or_none()
        if member_user is None:
            missing.append(email)
            continue
        if member_user.id in seen:
            continue
        seen.add(member_user.id)
        db.add(
            WorkspaceMember(
                user_id=member_user.id, workspace_slug=ws.slug, role=Role.user
            )
        )

    db.commit()
    db.refresh(ws)
    return ws, missing


def set_workspace_archived(
    db: Session, ws: Workspace, actor: User, archived: bool
) -> Workspace:
    """TF 보관/복원(읽기전용 보존). 라우트가 kind=tf + 권한을 먼저 검사."""
    ws.status = WorkspaceStatus.archived if archived else WorkspaceStatus.active
    if archived:
        ws.archived_at = datetime.utcnow()
        ws.archived_by_user_id = actor.id
    else:
        ws.archived_at = None
        ws.archived_by_user_id = None
    db.commit()
    db.refresh(ws)
    return ws


def member_tf_slugs(db: Session, user_id: int) -> set[str]:
    """이 사용자가 멤버인 TF 슬러그 집합. TF 는 상속이 없어 직접 멤버십만 본다
    (가시성 스코프 — org 처럼 전원 노출하지 않음)."""
    rows = db.execute(
        select(WorkspaceMember.workspace_slug)
        .join(Workspace, Workspace.slug == WorkspaceMember.workspace_slug)
        .where(
            WorkspaceMember.user_id == user_id,
            Workspace.kind == WorkspaceKind.tf,
        )
    ).scalars()
    return set(rows)
