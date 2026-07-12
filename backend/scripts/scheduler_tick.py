"""주기 스케줄러 tick 진입점 — systemd 타이머가 매분 실행.

worker.py 와 대칭(경량). due 한 데이터소스를 sync 잡으로 적재만 하고 끝난다(oneshot).
실제 동기화는 워커(reportarchive-worker.service)가 sync_data_source 핸들러로 처리하므로,
이 스케줄러가 의미 있으려면 워커도 함께 떠 있어야 한다.

사용:
    python scripts/scheduler_tick.py
"""
from __future__ import annotations

import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(BACKEND_ROOT / ".env")

# DataSource 매퍼 configure(FK 대상 모델 포함) — 전체 모델 등록.
import app.all_models  # noqa: E402,F401
from app.database import SessionLocal  # noqa: E402
from app.jobs.scheduler import (  # noqa: E402
    run_alerts_scheduler_tick,
    run_scheduler_tick,
)


def main() -> int:
    session = SessionLocal()
    try:
        r = run_scheduler_tick(session)
        print(
            f"[scheduler] due={r['due']} enqueued={r['enqueued']} "
            f"skipped={r['skipped']} at={r['at']}"
        )
        a = run_alerts_scheduler_tick(session)
        print(
            f"[scheduler:alerts] due={a['due']} enqueued={a['enqueued']} "
            f"skipped={a['skipped']} at={a['at']}"
        )
    finally:
        session.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
