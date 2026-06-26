"""B300 보조 AI 접근 제어 해석 + 게이트 (E, B300_보조AI_설계.md §E).

**기본 deny.** 시스템 관리자가 명시적으로 허락한 유저/조직만 기능을 쓴다. 가시성
(grants)과 다른 축 — "이 *기능*을 누가 쓰나". 전역 마스터 스위치(settings)와 AND:
엔티틀먼트는 "누구에게", settings 는 "기능 자체 on/off".
"""
from __future__ import annotations

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.models import AiEntitlement, AiFeature, AiSubjectKind
from app.config import settings
from app.database import get_db
from app.modules.users.models import User, WorkspaceMember
from app.modules.workspaces.models import Workspace
from app.shared.auth import get_current_user_no_workspace

# 와일드카드('all')가 펼쳐지는 실제 기능 집합. 새 B300 기능을 추가하면 여기에.
ALL_FEATURES: set[str] = {AiFeature.rag_qa.value, AiFeature.auto_summary.value}


def _add(feats: set[str], feature: AiFeature) -> None:
    if feature == AiFeature.all:
        feats |= ALL_FEATURES
    else:
        feats.add(feature.value)


def _member_slugs(db: Session, user: User) -> set[str]:
    """사용자가 멤버인 워크스페이스 slug + 홈(개인) 워크스페이스."""
    slugs = set(
        db.execute(
            select(WorkspaceMember.workspace_slug).where(
                WorkspaceMember.user_id == user.id
            )
        ).scalars()
    )
    if user.home_workspace_slug:
        slugs.add(user.home_workspace_slug)
    return slugs


def _ancestor_slugs(db: Session, slugs: set[str]) -> set[str]:
    """주어진 워크스페이스들의 모든 조상 slug(자신 제외). include_descendants
    grant 가 상위에 걸렸는지 판정하는 데 쓴다(Workspace.parent_slug 트리)."""
    out: set[str] = set()
    for slug in slugs:
        cur = db.get(Workspace, slug)
        cur = cur.parent_slug if cur else None
        seen: set[str] = set()
        while cur and cur not in seen:
            seen.add(cur)
            out.add(cur)
            node = db.get(Workspace, cur)
            cur = node.parent_slug if node else None
    return out


def ai_features_for(db: Session, user: User) -> set[str]:
    """이 사용자가 쓸 수 있는 B300 기능 집합. 빈 set = 권한 없음(기본 deny)."""
    # 관리자 우회(기본 on) — 운영 진단/테스트가 막히지 않게.
    if user.is_system_admin and settings.ai_admin_bypass:
        return set(ALL_FEATURES)

    feats: set[str] = set()
    # 1) 직접 유저 grant.
    user_grants = db.execute(
        select(AiEntitlement).where(
            AiEntitlement.enabled.is_(True),
            AiEntitlement.subject_kind == AiSubjectKind.user,
            AiEntitlement.user_id == user.id,
        )
    ).scalars()
    for e in user_grants:
        _add(feats, e.feature)

    # 2) 멤버인 워크스페이스 grant (+ include_descendants 면 조상 grant 도).
    member = _member_slugs(db, user)
    if member:
        ancestors = _ancestor_slugs(db, member)
        ws_grants = db.execute(
            select(AiEntitlement).where(
                AiEntitlement.enabled.is_(True),
                AiEntitlement.subject_kind == AiSubjectKind.workspace,
            )
        ).scalars()
        for e in ws_grants:
            if e.workspace_slug in member:
                _add(feats, e.feature)
            elif e.include_descendants and e.workspace_slug in ancestors:
                _add(feats, e.feature)
    return feats


def ai_enabled_for(db: Session, user: User, feature: str) -> bool:
    return feature in ai_features_for(db, user)


def require_ai_feature(feature: str):
    """라우트 의존성 팩토리 — 해당 B300 기능 권한이 없으면 403. 데이터 권한과
    직교(이건 '기능 사용 가능 여부'만; 어떤 보고서를 근거로 쓰는지는 검색 scope)."""

    def _dep(
        db: Session = Depends(get_db),
        user: User = Depends(get_current_user_no_workspace),
    ) -> User:
        if not ai_enabled_for(db, user, feature):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "이 AI 기능에 대한 접근 권한이 없습니다.",
            )
        return user

    return _dep
