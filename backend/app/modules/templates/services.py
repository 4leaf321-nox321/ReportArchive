"""Template services — versioning, visibility, widget-v1 validation."""
from __future__ import annotations

from typing import Optional

from sqlalchemy import desc, or_, select, update
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Session
from sqlalchemy import String as SAString
from sqlalchemy import cast

from app.modules.templates.models import Template
from app.modules.templates.schemas import TemplateCreate, TemplateNewVersion
from app.modules.users.models import WorkspaceMember
from app.modules.workspaces import services as ws_services
from app.widgets import validate_template_schema as _validate_widget_v1_schema


# --------------------------------------------------------------------------- #
# Visibility — hybrid sharing, multi-workspace
# --------------------------------------------------------------------------- #
def _visible_slugs_for(db: Session, workspace_slug: str) -> set[str]:
    """Returns the workspace slugs whose templates are visible to a user
    operating in `workspace_slug` (excluding the implicit "global" / NULL).

    A workspace sees:
      - Templates owned by itself or any *ancestor* (inherited down)
      - Templates owned by any *descendant* (a 본부 sees its 팀들의 것)
    Global templates (owner_workspace_slugs is NULL or empty) are always
    visible and are handled separately by the query.
    """
    descendants = set(ws_services.get_descendants_inclusive(db, workspace_slug))
    ancestors = {a.slug for a in ws_services.get_ancestors(db, workspace_slug)}
    return {*descendants, *ancestors}


def _is_global(template: Template) -> bool:
    return not template.owner_workspace_slugs


def _is_personal_slug(slug: str) -> bool:
    return slug.startswith("personal-")


def is_private_template(template: Template) -> bool:
    """개인(비공개) 템플릿 — 소유가 personal-* 뿐인 것. 목록에선 그 소유자에게만
    보이고, scope=all 작성 picker 에서도 남의 것은 제외된다. (렌더 by-id 는 별개로
    누구에게나 열려 있어, 이 템플릿으로 게시한 보고서는 모두에게 렌더된다.)"""
    owners = template.owner_workspace_slugs or []
    return bool(owners) and all(_is_personal_slug(s) for s in owners)


def _all_templates(
    db: Session, only_latest: bool, include_archived: bool = False
) -> list[Template]:
    query = select(Template)
    if only_latest:
        query = query.where(Template.is_latest.is_(True))
    if not include_archived:
        query = query.where(Template.archived_at.is_(None))
    return list(
        db.execute(
            query.order_by(Template.template_id, desc(Template.version))
        ).scalars()
    )


def list_templates(
    db: Session,
    workspace_slug: str,
    only_latest: bool = True,
    all_scopes: bool = False,
    user_id: Optional[int] = None,
    is_system_admin: bool = False,
    include_archived: bool = False,
) -> list[Template]:
    """워크스페이스 가시 범위로 필터한 템플릿 목록. `all_scopes=True` 면 소유 부서
    무시하고 **전체** 반환 — 작성(picker) 경로는 모든 사용자가 모든 (조직/전사)
    템플릿을 쓸 수 있어야 하므로(내 공간 포함) 이 모드를 쓴다. 단 **개인(비공개)
    템플릿은 그 소유자 본인에게만** 노출한다(`user_id` 로 판정). 소유 부서는
    가시성 가드가 아니라 *분류/관리* 메타로만 남는다(렌더는 by-id 가 열려 있음).
    관리/홈 화면은 기본(스코프) 모드로 조직별 분리를 유지한다.

    `is_system_admin=True` 면 모드 무관 **모든** 템플릿(타인 개인 비공개 포함)을
    반환한다 — 시스템 관리자는 전 템플릿을 보고 관리할 수 있어야 함."""
    if is_system_admin:
        return _all_templates(db, only_latest, include_archived=include_archived)

    if all_scopes:
        rows = _all_templates(db, only_latest, include_archived=include_archived)
        # 개인(비공개) 템플릿은 본인 것만 남긴다 — 남의 개인 템플릿은 picker 에서 제외.
        mine = f"personal-{user_id}" if user_id is not None else None
        return [
            t
            for t in rows
            if not is_private_template(t)
            or (mine is not None and mine in (t.owner_workspace_slugs or []))
        ]

    visible = _visible_slugs_for(db, workspace_slug)
    # 본인 개인(비공개) 템플릿은 어느 컨텍스트에서든 자기 목록에 보여야 한다
    # (org 보드 컨텍스트엔 personal-{me} 가 가시범위에 없어 누락되던 문제). 남의
    # 개인 템플릿은 추가하지 않는다 — 자기 것만.
    if user_id is not None:
        visible = visible | {f"personal-{user_id}"}

    # Global(NULL/빈 배열) OR 소유 슬러그가 가시범위와 겹침.
    conds = [
        Template.owner_workspace_slugs.is_(None),
        Template.owner_workspace_slugs == cast([], ARRAY(SAString)),
    ]
    if visible:
        conds.append(Template.owner_workspace_slugs.overlap(list(visible)))
    if user_id is not None:
        # 내가 만든 템플릿은 현재 활성 워크스페이스 가시 트리 밖(다른 부서 소유)
        # 이어도 관리 목록에 포함한다 — 작성 picker(scope=all)엔 뜨는데 "템플릿
        # 관리"엔 안 떠 불일치하던 문제. 편집/삭제 가능 여부는 프런트
        # canManageTemplate + 라우트 권한 게이트가 따로 판정한다.
        conds.append(Template.created_by_user_id == user_id)

    query = select(Template).where(or_(*conds))
    if only_latest:
        query = query.where(Template.is_latest.is_(True))
    if not include_archived:
        query = query.where(Template.archived_at.is_(None))

    return list(db.execute(query.order_by(Template.template_id, desc(Template.version))).scalars())


def get_template(db: Session, template_id: str, version: int) -> Optional[Template]:
    return db.get(Template, (template_id, version))


def get_latest_version(db: Session, template_id: str) -> Optional[Template]:
    return db.execute(
        select(Template).where(
            Template.template_id == template_id, Template.is_latest.is_(True)
        )
    ).scalar_one_or_none()


def list_versions(db: Session, template_id: str) -> list[Template]:
    return list(
        db.execute(
            select(Template)
            .where(Template.template_id == template_id)
            .order_by(desc(Template.version))
        ).scalars()
    )


def is_visible(db: Session, template: Template, workspace_slug: str) -> bool:
    if _is_global(template):
        return True
    visible = _visible_slugs_for(db, workspace_slug)
    return any(s in visible for s in (template.owner_workspace_slugs or []))


def is_visible_to_user(db: Session, template: Template, user_id: int) -> bool:
    """템플릿이 그 **계정(user)** 이 접근 가능한 범위에서 보이는지 — 자신이 멤버인
    모든 워크스페이스의 트리 가시범위(조상·자손)를 합쳐 판정한다.

    is_visible() 은 '지금 보고 있는 워크스페이스 한 곳' 기준이라, 개인공간에 둔
    보고서가 부서 전용 템플릿을 참조하면(개인공간엔 그 부서가 안 보임) 렌더용
    템플릿 조회가 막힌다. 보고서 렌더는 '현재 워크스페이스'가 아니라 '이 계정이
    그 템플릿을 볼 수 있나'로 판정해야 하므로 이 헬퍼를 쓴다."""
    if _is_global(template):
        return True
    owners = set(template.owner_workspace_slugs or [])
    if not owners:
        return True
    member_slugs = (
        db.execute(
            select(WorkspaceMember.workspace_slug).where(
                WorkspaceMember.user_id == user_id
            )
        )
        .scalars()
        .all()
    )
    visible: set[str] = set()
    for s in member_slugs:
        visible |= _visible_slugs_for(db, s)
    return bool(owners & visible)


def _normalize_owner_slugs(payload_slugs: Optional[list[str]]) -> Optional[list[str]]:
    """Normalize the owner_workspace_slugs payload field. Empty / None / all-
    blank → None (global). Otherwise return a deduped list preserving order."""
    if not payload_slugs:
        return None
    seen: set[str] = set()
    out: list[str] = []
    for s in payload_slugs:
        if not s or not s.strip():
            continue
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out or None


def set_template_scope(
    db: Session, template_id: str, owner_workspace_slugs: Optional[list[str]]
) -> Optional[Template]:
    """Replace the 공유 부서(scope) for ALL versions of `template_id` —
    metadata only, no new version (visibility, not schema). NULL/empty =
    전사(global). Target slugs may lie outside the caller's own tree (that's
    the point of *sharing* to another dept), so we only check that each is a
    real workspace. Permission is enforced in the route. Returns the latest
    version, or None if the template doesn't exist."""
    latest = get_latest_version(db, template_id)
    if latest is None:
        return None
    normalized = _normalize_owner_slugs(owner_workspace_slugs)
    if normalized:
        from app.modules.workspaces.models import Workspace

        for s in normalized:
            if db.get(Workspace, s) is None:
                raise ValueError(f"존재하지 않는 워크스페이스: {s}")
    db.execute(
        update(Template)
        .where(Template.template_id == template_id)
        .values(owner_workspace_slugs=normalized)
    )
    db.commit()
    return get_latest_version(db, template_id)


# --------------------------------------------------------------------------- #
# Schema validation (widget-v1)
# --------------------------------------------------------------------------- #
def validate_schema_document(schema_doc: dict) -> None:
    """Validates a template schema as widget-v1.

    Raises ValueError with a human-readable message identifying the offending
    block. The widget registry checks each block's props against the widget's
    own props_schema and ensures id uniqueness + no unknown widget types.
    """
    _validate_widget_v1_schema(schema_doc)


# --------------------------------------------------------------------------- #
# Mutations
# --------------------------------------------------------------------------- #
def create_template(db: Session, payload: TemplateCreate, created_by_user_id: int) -> Template:
    existing = db.execute(
        select(Template).where(Template.template_id == payload.template_id)
    ).first()
    if existing:
        raise ValueError(f"Template id already exists: {payload.template_id}")

    validate_schema_document(payload.schema_)

    template = Template(
        template_id=payload.template_id,
        version=1,
        name=payload.name,
        description=payload.description,
        category=payload.category,
        schema=payload.schema_,
        owner_workspace_slugs=_normalize_owner_slugs(payload.owner_workspace_slugs),
        is_published=True,
        is_latest=True,
        created_by_user_id=created_by_user_id,
    )
    db.add(template)
    db.commit()
    db.refresh(template)
    return template


def delete_template(db: Session, template_id: str) -> dict:
    """Deletes ALL versions of a template.

    Refuses if any reports reference any version (RESTRICT FK on the
    reports table). Returns a summary so the caller can surface a
    meaningful confirmation.
    """
    from app.modules.reports.models import Report

    versions = list_versions(db, template_id)
    if not versions:
        raise ValueError(f"Template not found: {template_id}")

    report_count = (
        db.query(Report).filter(Report.template_id == template_id).count()
    )
    if report_count > 0:
        raise ValueError(
            f"이 템플릿을 참조하는 보고서가 {report_count}건 있어 삭제할 수 없습니다. "
            f"보고서를 먼저 정리하거나 보관 처리해주세요."
        )

    for v in versions:
        db.delete(v)
    db.commit()
    return {
        "template_id": template_id,
        "deleted_versions": len(versions),
    }


def set_template_archived(
    db: Session,
    template_id: str,
    archived: bool,
    user_id: Optional[int] = None,
) -> dict:
    """템플릿을 보관/보관해제. template_id 의 **모든 버전 행**에 동일하게 적용한다
    (보관은 template_id 단위 개념). 삭제와 달리 보고서가 참조 중이어도 허용한다
    — 행이 살아 있어 기존 보고서 렌더는 그대로이고, 작성 picker·기본 목록에서만
    빠진다. 멱등(이미 그 상태면 그대로)."""
    from datetime import datetime

    versions = list_versions(db, template_id)
    if not versions:
        raise ValueError(f"Template not found: {template_id}")

    archived_at = datetime.utcnow() if archived else None
    archived_by = user_id if archived else None
    db.execute(
        update(Template)
        .where(Template.template_id == template_id)
        .values(archived_at=archived_at, archived_by_user_id=archived_by)
    )
    db.commit()
    return {
        "template_id": template_id,
        "archived": archived,
        "affected_versions": len(versions),
    }


def create_new_version(
    db: Session,
    template_id: str,
    payload: TemplateNewVersion,
    created_by_user_id: int,
) -> Template:
    latest = get_latest_version(db, template_id)
    if latest is None:
        raise ValueError(f"Template not found: {template_id}")

    validate_schema_document(payload.schema_)

    # Demote current latest.
    db.execute(
        update(Template)
        .where(Template.template_id == template_id, Template.is_latest.is_(True))
        .values(is_latest=False)
    )

    new_version = latest.version + 1
    template = Template(
        template_id=template_id,
        version=new_version,
        name=payload.name or latest.name,
        description=payload.description if payload.description is not None else latest.description,
        category=payload.category or latest.category,
        schema=payload.schema_,
        # Visibility is immutable across versions for now — carry the latest's
        # owner_workspace_slugs forward. If we want per-version visibility
        # later, accept it on the payload.
        owner_workspace_slugs=latest.owner_workspace_slugs,
        is_published=True,
        is_latest=True,
        created_by_user_id=created_by_user_id,
    )
    db.add(template)
    db.commit()
    db.refresh(template)
    return template
