"""Template routes — versioned, hybrid visibility, manager+ writes."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.modules.templates import services
from app.modules.templates.schemas import (
    TemplateArchiveUpdate,
    TemplateCreate,
    TemplateEntityTypesResponse,
    TemplateEntityTypesUpdate,
    TemplateNewVersion,
    TemplateRead,
    TemplateScopeUpdate,
    TemplateVersionSummary,
)
from app.modules.users.models import Role, WorkspaceMember
from app.modules.workspaces import services as ws_services
from app.shared.auth import CurrentUser, get_current_user, require_manager, resolve_role
from app.shared.responses import created_response, not_found_response, success_response

router = APIRouter()


def _own_personal_slug(actor: CurrentUser) -> str:
    return f"personal-{actor.user.id}"


def _is_own_personal_template(actor: CurrentUser, template) -> bool:
    """이 템플릿이 *이 계정의* 개인(비공개) 템플릿인가 — 소유가 본인 personal
    워크스페이스 단독. 생성/관리 권한을 현재 워크스페이스 컨텍스트와 무관하게
    소유자 본인에게 허용하는 데 쓴다."""
    return (template.owner_workspace_slugs or []) == [_own_personal_slug(actor)]


def _is_manager_anywhere(db: Session, user_id: int) -> bool:
    """계정이 '어느 부서든' 매니저 멤버십을 가졌나 — 전사 공개 템플릿 생성 허용용."""
    return (
        db.execute(
            select(WorkspaceMember.workspace_slug)
            .where(
                WorkspaceMember.user_id == user_id,
                WorkspaceMember.role == Role.manager,
            )
            .limit(1)
        ).first()
        is not None
    )


def _assert_can_create_template(db: Session, actor: CurrentUser, owner_slugs) -> None:
    """신규 템플릿 생성(+ 소속 부서 지정) 권한 — **활성부서(X-Workspace)와 무관하게
    계정 권한** 기준. 소속 부서는 모달에서 명시적으로 고르므로 컨텍스트가 아니라
    계정의 멤버십(트리 상속 반영)으로 판정한다.

    - 개인(비공개): 본인 personal 워크스페이스 단독 소유는 누구나.
    - 시스템 관리자: 제한 없음.
    - 매니저: 내가 매니저인 부서(그 부서 또는 조상에 manager 멤버십) + 그 하위 전체를
      원하는 만큼(다중) 소유 가능. 전사(빈 소유)는 계정이 어느 부서든 매니저면 허용.
    - 일반 멤버: 내 멤버십 서브트리(속한 부서 또는 그 하위) 안의 **한 부서**만 소유.
    """
    if actor.public_viewer:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "권한이 없습니다.")
    owners = list(owner_slugs or [])
    personal = _own_personal_slug(actor)
    # 개인(비공개) — 본인 personal 단독 소유만, 부서/전사 제약 없음.
    if owners == [personal]:
        return
    # 시스템 관리자 — 모든 부서 소유 가능.
    if actor.user.is_system_admin:
        return

    def _role_on(slug: str):
        return resolve_role(db, actor.user.id, slug)

    # 매니저: 지정한 모든 부서를 계정이 매니저로 관리하면 허용(다중 가능).
    if owners and all(_role_on(s) == Role.manager for s in owners):
        return
    # 전사 공개(빈 소유): 계정이 어느 부서든 매니저면 허용.
    if not owners:
        if _is_manager_anywhere(db, actor.user.id):
            return
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "전사 공개 템플릿은 매니저만 만들 수 있습니다.",
        )
    # 일반 멤버: 내 멤버십 서브트리 안의 한 부서만.
    if len(owners) == 1 and _role_on(owners[0]) is not None:
        return

    # 거부 — slug 는 UUID 형일 수 있어 부서 이름으로 표기.
    by_name = {w.slug: w.name for w in ws_services.list_workspaces(db)}
    labels = ", ".join(f"'{by_name.get(s, s)}'" for s in owners if s != personal)
    raise HTTPException(
        status.HTTP_403_FORBIDDEN,
        f"다음 부서에는 템플릿을 만들 수 없습니다: {labels}. "
        "(매니저는 관리 부서·그 하위를 여러 곳, 일반 멤버는 소속 부서 한 곳만 지정할 수 있습니다.)",
    )


def _assert_can_manage_template(actor: CurrentUser, template) -> None:
    """기존 템플릿의 새 버전 발행/삭제 권한.

    - 매니저: is_visible 을 통과한 템플릿이면 관리 가능(기존 동작 유지).
    - 일반 멤버: *자기 부서가 소유한* 템플릿만.
    """
    if actor.public_viewer:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "권한이 없습니다.")
    # 시스템 관리자는 모든 템플릿(타인 개인 비공개 포함)을 관리할 수 있다.
    if actor.user.is_system_admin:
        return
    # 개인(비공개) 템플릿은 소유자 본인이 관리(컨텍스트 무관).
    if _is_own_personal_template(actor, template):
        return
    if actor.is_manager:
        return
    owners = template.owner_workspace_slugs or []
    if actor.workspace.slug not in owners:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "자기 부서가 소유한 템플릿만 수정/삭제할 수 있습니다.",
        )


@router.get("")
def list_templates(
    only_latest: bool = True,
    scope: str = "workspace",
    include_archived: bool = False,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """템플릿 목록. `scope=all` 이면 소유 부서 무관 전체(작성 picker 용 — 모든
    사용자가 내 공간에서 모든 템플릿을 쓸 수 있어야 함). 기본 `scope=workspace`
    는 현재 워크스페이스 가시 범위로 필터(관리/홈 화면의 조직별 분리 유지).

    `include_archived=True` 면 보관된 템플릿도 포함한다(관리 화면이 보관 해제를
    하려고 쓴다). 기본 False — 작성 picker·홈에선 보관 템플릿이 빠진다."""
    items = services.list_templates(
        db,
        actor.workspace.slug,
        only_latest=only_latest,
        all_scopes=(scope == "all"),
        user_id=actor.user.id,
        is_system_admin=actor.user.is_system_admin,
        include_archived=include_archived,
    )
    payload = [TemplateRead.from_orm_(t) for t in items]
    return success_response(data=payload)


# --------------------------------------------------------------------------- #
# 단건/버전 조회 — **가시성 가드 없음**(인증만). 템플릿은 비밀 데이터가 아니라
# 보고서가 참조하는 공용 스키마이고, 어느 게시판/계정에서 보든 렌더돼야 한다
# (소유 부서 비멤버가 다른 부서 게시판에서 게시글을 볼 때 "불러오는 중"에서
# 멈추던 문제의 근본 해결). owner_workspace_slugs 는 *쓰기 권한·분류* 메타로만
# 남는다 — 쓰기 라우트(아래)는 여전히 가드한다.
# --------------------------------------------------------------------------- #
@router.get("/{template_id}")
def get_latest(
    template_id: str,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    template = services.get_latest_version(db, template_id)
    if not template:
        return not_found_response(f"Template not found: {template_id}")
    return success_response(data=TemplateRead.from_orm_(template))


@router.get("/{template_id}/versions")
def list_versions(
    template_id: str,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    versions = services.list_versions(db, template_id)
    if not versions:
        return not_found_response(f"Template not found: {template_id}")
    payload = [TemplateVersionSummary.model_validate(v) for v in versions]
    return success_response(data=payload)


@router.get("/{template_id}/versions/{version}")
def get_specific_version(
    template_id: str,
    version: int,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    template = services.get_template(db, template_id, version)
    if not template:
        return not_found_response(f"Template version not found: {template_id}@{version}")
    return success_response(data=TemplateRead.from_orm_(template))


@router.post("")
def create_template(
    payload: TemplateCreate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    # 매니저는 본인 트리 안 부서(또는 전사)에, 일반 멤버는 *자기 부서* 에만.
    _assert_can_create_template(db, actor, payload.owner_workspace_slugs)
    try:
        template = services.create_template(db, payload, created_by_user_id=actor.user.id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=TemplateRead.from_orm_(template))


@router.delete("/{template_id}")
def delete_template(
    template_id: str,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """Deletes ALL versions of a template. 매니저는 보이는 템플릿을, 일반
    멤버는 자기 부서가 소유한 템플릿을 삭제할 수 있다. 보고서가 아직 참조 중
    이면 거부(409)."""
    latest = services.get_latest_version(db, template_id)
    if not latest or not (
        services.is_visible(db, latest, actor.workspace.slug)
        or _is_own_personal_template(actor, latest)
        or actor.user.is_system_admin
    ):
        return not_found_response(f"Template not found: {template_id}")
    _assert_can_manage_template(actor, latest)
    try:
        result = services.delete_template(db, template_id)
    except ValueError as exc:
        # "not found" is 404, "in use" is 409. Distinguish by message.
        msg = str(exc)
        if "not found" in msg.lower():
            return not_found_response(msg)
        raise HTTPException(status.HTTP_409_CONFLICT, msg) from exc
    return success_response(
        data=result,
        message=f"'{template_id}' 템플릿의 {result['deleted_versions']}개 버전이 삭제되었습니다.",
    )


@router.patch("/{template_id}/archive")
def set_template_archived(
    template_id: str,
    payload: TemplateArchiveUpdate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """템플릿 보관/보관해제. 삭제와 같은 관리 권한(보이는 템플릿 또는 자기 부서
    소유)이면 가능하되, 삭제와 달리 **보고서가 참조 중이어도 허용**한다 — 보관은
    행을 지우지 않아 기존 보고서 렌더가 그대로다. 보관되면 작성 picker·기본
    목록에서 숨고 새 보고서 작성이 막힌다."""
    latest = services.get_latest_version(db, template_id)
    if not latest or not (
        services.is_visible(db, latest, actor.workspace.slug)
        or _is_own_personal_template(actor, latest)
        or actor.user.is_system_admin
    ):
        return not_found_response(f"Template not found: {template_id}")
    _assert_can_manage_template(actor, latest)
    try:
        result = services.set_template_archived(
            db, template_id, payload.archived, user_id=actor.user.id
        )
    except ValueError as exc:
        return not_found_response(str(exc))
    return success_response(
        data=result,
        message=(
            f"'{template_id}' 템플릿을 보관했습니다."
            if payload.archived
            else f"'{template_id}' 템플릿의 보관을 해제했습니다."
        ),
    )


@router.get("/{template_id}/entity-types", response_model=None)
def get_template_entity_types(
    template_id: str,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """이 템플릿으로 작성할 때 노출할 엔티티 축(유효값). 작성 picker 가 모든
    사용자에게 필요하므로 가시성 가드 없이(템플릿 존재만 확인) 반환한다 — 템플릿
    접근 모델(작성 picker=scope=all)과 일관. is_default=True 면 명시 바인딩이 없어
    전체 축 기본 노출."""
    if not services.get_latest_version(db, template_id):
        return not_found_response(f"Template not found: {template_id}")
    data = services.get_template_entity_types(db, template_id)
    return success_response(data=TemplateEntityTypesResponse(**data))


@router.put("/{template_id}/entity-types", response_model=None)
def set_template_entity_types(
    template_id: str,
    payload: TemplateEntityTypesUpdate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    """노출 축 집합 교체. 보관/공유와 같은 관리 권한(보이는 템플릿 또는 자기 부서
    소유, 또는 시스템 관리자)이면 가능. 빈 리스트면 전체 축 기본으로 복귀.
    버전은 올리지 않는다(작성 메타)."""
    latest = services.get_latest_version(db, template_id)
    if not latest or not (
        services.is_visible(db, latest, actor.workspace.slug)
        or _is_own_personal_template(actor, latest)
        or actor.user.is_system_admin
    ):
        return not_found_response(f"Template not found: {template_id}")
    _assert_can_manage_template(actor, latest)
    try:
        data = services.set_template_entity_types(db, template_id, payload.items)
    except ValueError as exc:
        return not_found_response(str(exc))
    return success_response(
        data=TemplateEntityTypesResponse(**data),
        message="노출 축을 저장했습니다.",
    )


@router.patch("/{template_id}/scope")
def set_template_scope(
    template_id: str,
    payload: TemplateScopeUpdate,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(require_manager),
):
    """다른 부서에 공유 — owner_workspace_slugs(공유 부서)를 통째로 교체한다.
    버전은 올리지 않는다(가시성 메타). 템플릿을 소유한 부서의 매니저만 가능.
    공유 대상 부서는 본인 트리 밖일 수 있다(그게 공유의 목적)."""
    latest = services.get_latest_version(db, template_id)
    if not latest or not (
        services.is_visible(db, latest, actor.workspace.slug)
        or _is_own_personal_template(actor, latest)
        or actor.user.is_system_admin
    ):
        return not_found_response(f"Template not found: {template_id}")
    # 개인(비공개) 템플릿 소유자는 본인 것의 공유 범위를 자유롭게 바꿀 수 있다
    # (비공개 → 부서/전사 승격). 그 외엔 소유 부서가 본인 트리 안이어야 한다.
    if _is_own_personal_template(actor, latest):
        try:
            template = services.set_template_scope(
                db, template_id, payload.owner_workspace_slugs
            )
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        if template is None:
            return not_found_response(f"Template not found: {template_id}")
        return success_response(data=TemplateRead.from_orm_(template))
    # 권한: 현재 이 템플릿을 *소유한* 부서(들) 중 하나가 본인 관리 트리 안에
    # 있어야 한다. 전사(소유 없음) 템플릿은 여기서 못 바꾼다(관리자 영역).
    current_owners = latest.owner_workspace_slugs or []
    if not current_owners:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "전사 공개 템플릿의 공유 범위는 여기서 바꿀 수 없습니다 (관리자에게 문의).",
        )
    from app.modules.workspaces import services as ws_services

    accessible = set(ws_services.get_descendants_inclusive(db, actor.workspace.slug))
    if not any(s in accessible for s in current_owners):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "이 템플릿을 소유한 부서의 매니저만 공유 범위를 바꿀 수 있습니다.",
        )
    try:
        template = services.set_template_scope(
            db, template_id, payload.owner_workspace_slugs
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    if template is None:
        return not_found_response(f"Template not found: {template_id}")
    return success_response(data=TemplateRead.from_orm_(template))


@router.post("/{template_id}/versions")
def publish_new_version(
    template_id: str,
    payload: TemplateNewVersion,
    db: Session = Depends(get_db),
    actor: CurrentUser = Depends(get_current_user),
):
    latest = services.get_latest_version(db, template_id)
    if not latest or not (
        services.is_visible(db, latest, actor.workspace.slug)
        or _is_own_personal_template(actor, latest)
        or actor.user.is_system_admin
    ):
        return not_found_response(f"Template not found: {template_id}")
    _assert_can_manage_template(actor, latest)
    try:
        template = services.create_new_version(
            db, template_id, payload, created_by_user_id=actor.user.id
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return created_response(data=TemplateRead.from_orm_(template))
