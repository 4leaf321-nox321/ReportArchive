"""커넥터 시크릿 대칭 암호화 — 저장 시 API 토큰/비밀번호를 평문으로 두지 않는다.

키는 앱 시크릿(settings.secret_key)에서 결정적으로 파생 — 별도 키 관리·env 불필요.
운영에서 secret_key 는 배포 시 임의값으로 채워진다(deploy.sh). 저장값에 `enc:v1:`
접두사를 붙여 **레거시 평문과 구분**한다(v3 이전에 만든 소스는 다음 저장 때 자동 암호화).
"""
from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings

_PREFIX = "enc:v1:"


def _fernet() -> Fernet:
    # 앱 시크릿 → SHA256(32바이트) → urlsafe base64 = Fernet 키.
    digest = hashlib.sha256(
        ("connector-secret:" + settings.secret_key).encode("utf-8")
    ).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(plaintext: str) -> str:
    """평문 → `enc:v1:<token>`. 빈 값은 그대로 빈 값."""
    if not plaintext:
        return ""
    return _PREFIX + _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_secret(stored: str) -> str:
    """저장값 → 평문. 접두사가 없으면 레거시 평문으로 간주해 그대로 반환.
    키가 바뀌었거나 손상돼 복호 실패하면 빈 값(재입력 유도)."""
    if not stored:
        return ""
    if not stored.startswith(_PREFIX):
        return stored  # 레거시 평문
    try:
        return _fernet().decrypt(stored[len(_PREFIX):].encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return ""


def is_encrypted(stored: str) -> bool:
    return bool(stored) and stored.startswith(_PREFIX)
