"""Authentication primitives — password hashing + JWT issue/verify."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.modules.users.models import User

# bcrypt is the single supported scheme; auto-deprecated keeps room for migration.
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

JWT_ALGORITHM = "HS256"


# --------------------------------------------------------------------------- #
# Password
# --------------------------------------------------------------------------- #
def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: Optional[str]) -> bool:
    if not hashed:
        return False
    return pwd_context.verify(plain, hashed)


# --------------------------------------------------------------------------- #
# Password reset tokens (셀프 재설정 — 이메일 링크)
# --------------------------------------------------------------------------- #
PASSWORD_RESET_EXPIRE_MINUTES = 30


def _hash_reset_token(raw: str) -> str:
    import hashlib

    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def create_password_reset_token(db: Session, user: User) -> str:
    """원문 토큰을 반환(이메일 링크용). DB엔 해시만 저장. 커밋은 호출자."""
    import secrets

    from app.modules.users.models import PasswordResetToken

    raw = secrets.token_urlsafe(32)
    row = PasswordResetToken(
        user_id=user.id,
        token_hash=_hash_reset_token(raw),
        expires_at=datetime.utcnow()
        + timedelta(minutes=PASSWORD_RESET_EXPIRE_MINUTES),
    )
    db.add(row)
    db.flush()
    return raw


def consume_password_reset_token(db: Session, raw: str) -> Optional[User]:
    """유효한(미사용·미만료) 토큰이면 소비(used_at 기록)하고 대상 User 반환.
    실패 시 None. 커밋은 호출자."""
    from app.modules.users.models import PasswordResetToken

    if not raw:
        return None
    row = db.execute(
        select(PasswordResetToken).where(
            PasswordResetToken.token_hash == _hash_reset_token(raw)
        )
    ).scalar_one_or_none()
    if row is None or row.used_at is not None:
        return None
    if row.expires_at < datetime.utcnow():
        return None
    row.used_at = datetime.utcnow()
    db.flush()
    return db.get(User, row.user_id)


# --------------------------------------------------------------------------- #
# JWT
# --------------------------------------------------------------------------- #
def create_access_token(user_id: int) -> str:
    """Sign a JWT carrying the user id. Short-lived; the frontend re-fetches
    /api/me on each load to discover the current user / role."""
    now = datetime.now(tz=timezone.utc)
    payload = {
        "sub": str(user_id),
        "iat": int(now.timestamp()),
        "exp": int((now + settings.jwt_access_token_expires).timestamp()),
        "type": "access",
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    """Returns the JWT payload. Raises jwt.PyJWTError on any failure
    (expired / invalid signature / wrong type)."""
    payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[JWT_ALGORITHM])
    if payload.get("type") != "access":
        raise jwt.InvalidTokenError("not an access token")
    return payload


# --------------------------------------------------------------------------- #
# Upload ticket — short-lived, single-purpose JWT for out-of-band file upload
# --------------------------------------------------------------------------- #
# A CLI agent (Claude Code) uploads a local file by curl-ing the MCP server's
# /files/upload route directly (bytes never pass through the model). That curl
# can't carry the user's PAT, so an MCP tool mints this ticket through the
# normal authenticated path and hands it to the agent. The backend upload
# route trusts the ticket's signed claims (user + workspace) instead of
# re-authenticating. Kept deliberately short (default 5 min) and typed so it
# can't be used as an access token.
UPLOAD_TICKET_TTL_MINUTES = 5


def create_upload_ticket(
    user_id: int, workspace_slug: str, *, minutes: int = UPLOAD_TICKET_TTL_MINUTES
) -> str:
    now = datetime.now(tz=timezone.utc)
    payload = {
        "sub": str(user_id),
        "ws": workspace_slug,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=minutes)).timestamp()),
        "type": "upload",
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=JWT_ALGORITHM)


def decode_upload_ticket(token: str) -> Optional[dict]:
    """Returns `{user_id, workspace_slug}` for a valid upload ticket, else
    None (expired / bad signature / wrong type / malformed)."""
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None
    if payload.get("type") != "upload":
        return None
    sub = payload.get("sub")
    ws = payload.get("ws")
    if sub is None or not ws:
        return None
    try:
        return {"user_id": int(sub), "workspace_slug": str(ws)}
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# Login flow
# --------------------------------------------------------------------------- #
def authenticate(db: Session, email: str, password: str) -> Optional[User]:
    """Returns the user if email + password match, else None.

    Constant-time-ish: we still call verify_password against a dummy hash if
    the user doesn't exist so the timing reveal between "wrong email" and
    "wrong password" stays small.
    """
    user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if not user or not user.is_active:
        # Touch bcrypt to keep timing roughly equal to the success path.
        pwd_context.dummy_verify()
        return None
    if not verify_password(password, user.password_hash):
        return None
    return user
