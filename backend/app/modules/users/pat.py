"""개인 액세스 토큰(Personal Access Token) — 발급·검증·취소.

MCP 서버 등 외부 클라이언트가 `Authorization: Bearer rat_...` 로 쓴다. 평문은 발급
시 1회만 반환하고 DB 엔 sha256 해시만 둔다. 인증 경로(app.shared.auth)가 접두사로
JWT 와 구분해 resolve_token 을 호출한다.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.users.models import PersonalAccessToken, User

TOKEN_PREFIX = "rat_"  # ReportArchive Token — JWT 와 구분되는 접두사
DEFAULT_EXPIRES_DAYS = 90
# last_used_at 잦은 갱신 억제(인증 경로 쓰기 최소화).
_TOUCH_INTERVAL = timedelta(minutes=10)


def _hash(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def create_token(
    db: Session, user_id: int, name: str, *, expires_days: int | None = DEFAULT_EXPIRES_DAYS
) -> tuple[PersonalAccessToken, str]:
    """새 토큰 발급. (행, 평문) 반환 — 평문은 호출부가 1회만 사용자에게 노출."""
    plaintext = TOKEN_PREFIX + secrets.token_urlsafe(32)
    now = datetime.utcnow()
    row = PersonalAccessToken(
        user_id=user_id,
        name=(name or "MCP 토큰").strip()[:100],
        token_prefix=plaintext[:12],  # 표시용(rat_ + 앞 8자)
        token_hash=_hash(plaintext),
        created_at=now,
        expires_at=(now + timedelta(days=expires_days)) if expires_days else None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row, plaintext


def list_tokens(db: Session, user_id: int) -> list[PersonalAccessToken]:
    """취소된 것 포함 전체(최신순) — UI 가 상태 표시."""
    return list(
        db.execute(
            select(PersonalAccessToken)
            .where(PersonalAccessToken.user_id == user_id)
            .order_by(PersonalAccessToken.id.desc())
        ).scalars()
    )


def revoke_token(db: Session, user_id: int, token_id: int) -> bool:
    row = db.get(PersonalAccessToken, token_id)
    if row is None or row.user_id != user_id:
        return False
    if row.revoked_at is None:
        row.revoked_at = datetime.utcnow()
        db.commit()
    return True


def resolve_token(db: Session, plaintext: str) -> User | None:
    """평문 토큰 → 사용자. 취소·만료·비활성·미존재면 None. 유효하면 last_used_at
    을 가끔 갱신(인증 경로라 쓰기 최소화)."""
    if not plaintext or not plaintext.startswith(TOKEN_PREFIX):
        return None
    row = db.execute(
        select(PersonalAccessToken).where(
            PersonalAccessToken.token_hash == _hash(plaintext)
        )
    ).scalars().first()
    if row is None or row.revoked_at is not None:
        return None
    now = datetime.utcnow()
    if row.expires_at is not None and row.expires_at <= now:
        return None
    user = db.get(User, row.user_id)
    if user is None or not user.is_active:
        return None
    if row.last_used_at is None or (now - row.last_used_at) > _TOUCH_INTERVAL:
        row.last_used_at = now
        db.commit()
    return user
