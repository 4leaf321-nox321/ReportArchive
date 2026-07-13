"""Workspace tree services.

Tree traversal is done in Python (org chart is small enough that recursive
CTEs aren't worth the complexity).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.shared.dependents import Dependent, count_blockers, fk_blocking_dependents
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


# 부서(workspaces.slug)를 참조하는 FK 의 사람이 읽는 라벨. 자기참조(parent_slug)는
# 테이블명이 'workspaces' 라 반드시 여기서 'children' 으로 매핑해야 한다.
_WS_FK_LABELS = {
    ("workspaces", "parent_slug"): ("children", "자식 부서"),
    ("reports", "workspace_slug"): ("reports", "보고서"),
    ("files", "workspace_slug"): ("files", "파일"),
    ("html_embed_bundles", "workspace_slug"): ("html_embed_bundles", "HTML 임베드 번들"),
    ("composite_reports", "workspace_slug"): ("composite_reports", "종합보고"),
}


def _count_ws_members(db: Session, slug) -> int:
    return int(
        db.execute(
            select(func.count(WorkspaceMember.id)).where(
                WorkspaceMember.workspace_slug == slug
            )
        ).scalar()
        or 0
    )


def _count_ws_owner_templates(db: Session, slug) -> int:
    return int(
        db.execute(
            select(func.count(Template.template_id)).where(
                Template.owner_workspace_slugs.contains([slug])
            )
        ).scalar()
        or 0
    )


def workspace_dependents() -> list[Dependent]:
    """부서를 참조하는 삭제 차단 항목의 레지스트리(조직개편·계정삭제_설계.md §3).

    자동수집(FK RESTRICT/NO ACTION): reports·files·html_embed_bundles·
    composite_reports·자식 부서(parent_slug 자기참조). 새 테이블이 workspaces.slug
    를 RESTRICT FK 로 참조하면 코드 수정 없이 자동 편입된다.

    수동보충(FK 만으로 안 잡히는 정책 차단):
      - members: FK 는 CASCADE 지만 사람이 남은 부서는 삭제 거부(정책).
      - templates: owner_workspace_slugs 배열(FK 없음) — 죽은 slug 참조 방지.
    """
    deps = fk_blocking_dependents("workspaces", "slug", labels=_WS_FK_LABELS)
    deps.append(
        Dependent(
            key="members",
            label="멤버",
            blocks=True,
            count=_count_ws_members,
            detail="CASCADE-policy",
        )
    )
    deps.append(
        Dependent(
            key="templates",
            label="이 부서가 소유한 템플릿",
            blocks=True,
            count=_count_ws_owner_templates,
            detail="array",
        )
    )
    return deps


def workspace_blockers(db: Session, slug: str) -> dict:
    """삭제를 막는 의존 항목별 행 수 {key: count}. 전부 0 이면 삭제 가능.

    레지스트리(workspace_dependents)를 순회하므로, 예전처럼 4종만 세지 않고
    files/html_embed_bundles/composite_reports 등 RESTRICT FK 를 빠짐없이 센다
    (부서 삭제 500 버그 방지)."""
    return count_blockers(db, workspace_dependents(), slug)


def workspace_fk_blockers(db: Session, slug: str) -> dict:
    """실제 DB FK(RESTRICT/NO ACTION)로 삭제를 막는 것만 {key: count}. members(정책)·
    templates(배열)는 뺀다. 계정 삭제 시 개인 작업공간이 CASCADE 로 지워질 때 그
    삭제가 성공할지(=남은 RESTRICT 참조가 없는지) 판정하는 용도
    (조직개편·계정삭제_설계.md §6.2)."""
    return count_blockers(
        db, fk_blocking_dependents("workspaces", "slug", labels=_WS_FK_LABELS), slug
    )


def delete_workspace(db: Session, ws: Workspace) -> None:
    blockers = workspace_blockers(db, ws.slug)
    if any(blockers.values()):
        parts = [f"{k}={v}" for k, v in blockers.items() if v]
        raise ValueError(
            f"부서를 삭제할 수 없습니다 (참조 중: {', '.join(parts)}). "
            f"먼저 정리하거나 보관(archive)하세요."
        )
    try:
        db.delete(ws)
        db.commit()
    except IntegrityError as exc:
        # 레지스트리가 미처 못 잡은 참조가 있어도 500 대신 409 로 — 500 원천 차단.
        db.rollback()
        raise ValueError(
            "부서를 삭제할 수 없습니다: 예상치 못한 참조가 남아 있습니다."
        ) from exc


def hard_delete_tf_workspace(db: Session, ws: Workspace) -> dict:
    """TF(태스크포스) 완전 삭제 — 테스트로 만든 TF 정리용. 보관(archive)이 행을
    남겨두는 것과 달리 실제로 DELETE 한다.

    자동 정리(FK CASCADE): 멤버십·폴더·게시(mount)·게시판/폴더/종합보고 grant.
    수동 정리(FK 없음): ContentGrant(부서 principal), Template.owner_workspace_slugs
    배열 참조.
    거부 조건: 이 TF 가 *소유한* 보고서가 있으면(reports.workspace_slug=RESTRICT)
    삭제 불가 — 보고서를 먼저 옮기거나 지워야 한다(실수로 보고서 유실 방지).

    라우트가 kind=tf + 권한(그 TF 매니저 또는 시스템관리자)을 먼저 검사한다."""
    from sqlalchemy import delete as sa_delete
    from app.modules.grants.models import ContentGrant, GrantPrincipalType

    if ws.kind != WorkspaceKind.tf:
        raise ValueError("TF(태스크포스)만 완전 삭제할 수 있습니다.")

    report_count = (
        db.execute(
            select(func.count(Report.id)).where(Report.workspace_slug == ws.slug)
        ).scalar()
        or 0
    )
    if report_count > 0:
        raise ValueError(
            f"이 TF 가 소유한 보고서가 {report_count}건 있어 삭제할 수 없습니다. "
            f"보고서를 먼저 옮기거나 삭제한 뒤 다시 시도하세요."
        )

    # 1) ContentGrant — 이 TF 를 principal 로 가진 행(부서 / 부서매니저). FK 없음.
    db.execute(
        sa_delete(ContentGrant).where(
            ContentGrant.principal_ref == ws.slug,
            ContentGrant.principal_type.in_(
                [
                    GrantPrincipalType.workspace,
                    GrantPrincipalType.workspace_manager,
                ]
            ),
        )
    )
    # 2) Template.owner_workspace_slugs 배열에서 이 slug 제거(공유/분류 메타). 비면
    #    None(=전사) 로 — 죽은 slug 참조를 남기는 것보다 낫다(테스트 TF엔 드묾).
    tmpls = db.execute(
        select(Template).where(Template.owner_workspace_slugs.contains([ws.slug]))
    ).scalars()
    for t in tmpls:
        remaining = [s for s in (t.owner_workspace_slugs or []) if s != ws.slug]
        t.owner_workspace_slugs = remaining or None

    # 나머지(멤버·폴더·mount·board/folder/composite grant)는 FK CASCADE 가 정리.
    db.delete(ws)
    db.commit()
    return {"slug": ws.slug, "deleted": True}


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
    """부서 보관/복원(읽기전용 보존 — 자료 이관 없음). org·tf 에 쓴다(조직개편·
    계정삭제_설계.md §4). 라우트가 kind·권한을 먼저 검사한다.

    O1(잠정): org 를 보관할 때 active 자식 부서가 남아 있으면 거부한다 — 부모만
    숨기면 자식이 트리에서 붕 뜨므로 자식부터 정리·재부모화하게 한다. tf 는
    트리 밖(자식 없음)이라 해당 없음.
    """
    if archived and ws.kind == WorkspaceKind.org:
        active_children = (
            db.execute(
                select(func.count(Workspace.slug)).where(
                    Workspace.parent_slug == ws.slug,
                    Workspace.status == WorkspaceStatus.active,
                )
            ).scalar()
            or 0
        )
        if active_children:
            raise ValueError(
                f"하위 부서 {active_children}개가 아직 활성 상태라 보관할 수 없습니다. "
                f"하위 부서를 먼저 보관하거나 옮기세요."
            )
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
