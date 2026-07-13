"""User(계정) 서비스 — 하드삭제(계정 완전 삭제) 로직.

배경(조직개편·계정삭제_설계.md §6): 계정은 비활성화(is_active 토글)만 있고 삭제가
없었다. 잘못된 메일주소로 가입한 저(低)흔적 계정을 실제로 지우려면 하드삭제가
필요하다. 방침은 **저흔적만 하드삭제, 흔적 있으면 거부→비활성화 유도**:

  - users.id 를 RESTRICT 로 참조하는 것(작성한 댓글/댓글스레드)이 있으면 거부.
  - 개인 작업공간에 CASCADE 삭제를 막는 RESTRICT 참조(보고서·파일·임베드·종합보고)
    가 남아 있으면 거부(그대로 삭제하면 개인공간 CASCADE 가 막혀 500).
  - 통과하면 FK CASCADE 가 멤버십·토큰·개인공간(빈 경우)·알림 등을 정리하고,
    SET NULL 이 작성 보고서 소유권 등을 NULL 로 보존한 뒤 계정을 지운다.
  - 삭제 후 그 이메일(unique)이 해방돼 정정/재가입이 가능해진다(핵심 목적).

가드(자기 자신·마지막 시스템관리자 금지)는 라우트가 set_user_active 와 동일하게
먼저 검사한다.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.modules.users.models import User
from app.modules.workspaces.models import Workspace
from app.modules.workspaces.services import workspace_fk_blockers
from app.shared.dependents import Dependent, count_blockers, fk_blocking_dependents

# users.id 를 RESTRICT 로 참조하는 FK 의 사람이 읽는 라벨.
_USER_FK_LABELS = {
    ("comment_threads", "author_user_id"): ("comment_threads", "작성한 댓글 스레드"),
    ("comments", "author_user_id"): ("comments", "작성한 댓글"),
}


def _count_personal_content(db: Session, user_id) -> int:
    """이 사용자의 개인 작업공간(들)에 CASCADE 삭제를 막는 RESTRICT 참조(보고서·
    파일·임베드·종합보고·자식)가 총 몇 건인지. >0 이면 계정 삭제가 개인공간
    CASCADE 단계에서 막힌다."""
    slugs = (
        db.execute(
            select(Workspace.slug).where(Workspace.personal_owner_user_id == user_id)
        )
        .scalars()
        .all()
    )
    total = 0
    for slug in slugs:
        total += sum(workspace_fk_blockers(db, slug).values())
    return total


def user_dependents() -> list[Dependent]:
    """계정 삭제를 막는 항목의 레지스트리(조직개편·계정삭제_설계.md §6).

    자동수집(users.id RESTRICT FK): comment_threads·comments. 새 테이블이
    users.id 를 RESTRICT FK 로 참조하면 코드 수정 없이 자동 편입된다.
    수동보충: personal_content(개인 작업공간의 RESTRICT 참조 — 간접 차단)."""
    deps = fk_blocking_dependents("users", "id", labels=_USER_FK_LABELS)
    deps.append(
        Dependent(
            key="personal_content",
            label="개인 작업공간의 보고서·파일 등",
            blocks=True,
            count=_count_personal_content,
            detail="indirect",
        )
    )
    return deps


def user_delete_blockers(db: Session, user: User) -> dict:
    """계정 삭제를 막는 항목별 건수 {key: count}. 전부 0 이면 하드삭제 가능."""
    return count_blockers(db, user_dependents(), user.id)


def hard_delete_user(db: Session, user: User) -> dict:
    """계정 완전 삭제. 라우트가 가드(자기 자신·마지막 시스템관리자)를 먼저 검사.

    거부 조건: user_delete_blockers 가 하나라도 >0 (작성 댓글 / 개인공간 내용).
    통과 시 FK CASCADE·SET NULL 이 나머지를 정리하고 계정을 지운다."""
    blockers = user_delete_blockers(db, user)
    if any(blockers.values()):
        parts = [f"{k}={v}" for k, v in blockers.items() if v]
        raise ValueError(
            f"이 계정은 삭제할 수 없습니다 (참조 중: {', '.join(parts)}). "
            f"작성한 댓글이나 개인 보고서를 먼저 정리하거나, 계정을 비활성화하세요."
        )
    try:
        db.delete(user)
        db.commit()
    except IntegrityError as exc:
        # 레지스트리가 미처 못 잡은 참조가 있어도 500 대신 409 로 — 500 원천 차단.
        db.rollback()
        raise ValueError(
            "이 계정은 삭제할 수 없습니다: 예상치 못한 참조가 남아 있습니다. "
            "계정을 비활성화하세요."
        ) from exc
    return {"user_id": user.id, "deleted": True}
