"""Authentication primitives — password hashing + JWT issue/verify."""
from __future__ import annotations

from datetime import datetime, timezone
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
