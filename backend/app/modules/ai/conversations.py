"""대화형 에이전트 검색 — 저장된 대화 CRUD (사용자별 private).

모든 조회/수정은 **소유자(user_id)** 로 스코프. 남의 대화는 존재조차 안 보인다(404).
messages 는 스레드 전체([{role,content,result?}])를 통째 저장/반환.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.models import AiConversation

_LIST_LIMIT = 100
_TITLE_MAX = 200


def list_for_user(db: Session, user_id: int) -> list[AiConversation]:
    stmt = (
        select(AiConversation)
        .where(AiConversation.user_id == user_id)
        .order_by(AiConversation.updated_at.desc())
        .limit(_LIST_LIMIT)
    )
    return list(db.execute(stmt).scalars())


def get_owned(db: Session, conv_id: int, user_id: int) -> Optional[AiConversation]:
    conv = db.get(AiConversation, conv_id)
    if conv is None or conv.user_id != user_id:
        return None  # 남의 대화는 존재 비노출
    return conv


def create(db: Session, user_id: int, *, title: str, messages: list) -> AiConversation:
    conv = AiConversation(
        user_id=user_id,
        title=(title or "새 대화")[:_TITLE_MAX],
        messages=messages or [],
    )
    db.add(conv)
    db.commit()
    db.refresh(conv)
    return conv


def update(db: Session, conv: AiConversation, *, title=None, messages=None) -> AiConversation:
    if title is not None:
        conv.title = title[:_TITLE_MAX]
    if messages is not None:
        conv.messages = messages
    db.commit()
    db.refresh(conv)
    return conv


def delete(db: Session, conv: AiConversation) -> None:
    db.delete(conv)
    db.commit()
