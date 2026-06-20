"""Bootstrap-time loader for tunable runtime settings.

`runtime_settings` 테이블의 값을 SQLAlchemy *없이* 한 번 읽어들이는
얇은 헬퍼. run.py 와 database.py 가 둘 다 엔진 생성 *전* 에 이 값을
필요로 하기 때문 — SessionLocal 을 쓰면 chicken-and-egg.

폴백 체인: DB → 환경변수 → 모듈 하드코드 default. DB 가 죽어 있거나
첫 배포라 테이블이 없는 경우에도 앱은 degraded 모드로 부팅된다.

각 워커 프로세스가 import 시 한 번씩 DB 를 열고 닫는다 (psycopg
short-lived connection, ~10ms). 결과는 모듈 레벨 캐시라 같은 프로세스
내에서는 재질의 없음. 값 변경 후엔 운영자가 systemctl restart 로
워커를 재기동해야 새 값이 반영된다.
"""
from __future__ import annotations

import os
import re
from typing import Dict, Optional

import psycopg

from app.config import settings

# 프론트엔드 / 마이그레이션과 키 이름 동기화 필수.
# 값: (env var key, default int).
_TUNABLES: Dict[str, tuple[str, int]] = {
    "uvicorn_workers": ("UVICORN_WORKERS", 4),
    "db_pool_size": ("DB_POOL_SIZE", 5),
    "db_max_overflow": ("DB_MAX_OVERFLOW", 10),
    # 백그라운드 워커(worker.py) — 별도 프로세스라 웹 워커 수와 무관.
    "worker_concurrency": ("WORKER_CONCURRENCY", 2),
    "worker_poll_ms": ("WORKER_POLL_MS", 1000),
}

# 안전 상한 — UI 가 슬라이더 max 로 쓰고 백엔드도 PUT 단계에서 clamp.
LIMITS: Dict[str, tuple[int, int]] = {
    "uvicorn_workers": (1, 32),
    "db_pool_size": (1, 50),
    "db_max_overflow": (0, 50),
    "worker_concurrency": (1, 16),
    "worker_poll_ms": (100, 60000),
}

_cache: Optional[Dict[str, str]] = None


def _psycopg_url(url: str) -> str:
    """SQLAlchemy URL 의 `postgresql+psycopg://...` 드라이버 힌트를 떼고
    plain `postgresql://...` 로. psycopg.connect 가 직접 못 읽는 형식."""
    return re.sub(r"^postgresql\+\w+://", "postgresql://", url)


def _load_from_db() -> Dict[str, str]:
    """단발성 psycopg 연결로 runtime_settings 조회. 실패하면 빈 dict."""
    out: Dict[str, str] = {}
    try:
        # connect_timeout 으로 DB 가 죽어 있을 때 부팅이 무한대기에 빠지는
        # 케이스 방지. ~3초면 헬스 어딘가에서 잡힘.
        with psycopg.connect(
            _psycopg_url(settings.database_url),
            connect_timeout=3,
        ) as conn:
            with conn.cursor() as cur:
                # 키 목록은 _TUNABLES 에서 파생 — 새 튜닝 키 추가 시 자동 포함.
                cur.execute(
                    "SELECT key, value FROM runtime_settings WHERE key = ANY(%s)",
                    (list(_TUNABLES.keys()),),
                )
                for key, value in cur.fetchall():
                    if value is not None:
                        out[key] = value
    except Exception:  # noqa: BLE001 — 테이블 없음 / DB down 모두 silent fallback
        pass
    return out


def get_int(key: str) -> int:
    """튜닝 키의 effective int 값. DB → env → default 순으로 fallback,
    상하한 clamp."""
    global _cache
    if _cache is None:
        _cache = _load_from_db()
    raw: Optional[str] = _cache.get(key)
    if raw is None:
        env_key, default = _TUNABLES.get(key, ("", 0))
        raw = os.environ.get(env_key)
        if raw is None:
            value = default
        else:
            try:
                value = int(raw)
            except ValueError:
                value = default
    else:
        try:
            value = int(raw)
        except ValueError:
            value = _TUNABLES.get(key, ("", 0))[1]
    lo, hi = LIMITS.get(key, (0, 1_000_000))
    return max(lo, min(hi, value))


def invalidate() -> None:
    """모듈 캐시 클리어 — 같은 프로세스 안에서 강제로 DB 재질의. 보통
    워커 재시작이 정석이고 이 함수는 동일 프로세스 내 디버깅용."""
    global _cache
    _cache = None
