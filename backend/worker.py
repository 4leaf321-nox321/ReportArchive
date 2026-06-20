"""Background Worker Entry Point.

run.py 와 대칭. 같은 SIF·venv·.env·DB 를 쓰되 uvicorn 대신 작업 큐 워커를
띄운다. systemd 유닛(reportarchive-worker.service)이 이걸 실행한다.

Usage:
    python worker.py
환경변수(또는 runtime_settings 테이블):
    WORKER_CONCURRENCY  동시 처리 스레드 수 (기본 2)
    WORKER_POLL_MS      유휴 시 폴링 간격 ms (기본 1000)
"""
from __future__ import annotations

import logging
import signal
from pathlib import Path

from dotenv import load_dotenv

BACKEND_ROOT = Path(__file__).resolve().parent
load_dotenv(BACKEND_ROOT / ".env")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    # 전체 ORM 모델 등록 — 핸들러가 도메인 모델(Report·File·Composite…)을
    # 건드릴 때 SQLAlchemy 매퍼가 깨끗하게 configure 되도록.
    import app.all_models  # noqa: F401
    # 핸들러 등록(부작용 import) — 이게 있어야 registry 가 채워진다.
    import app.jobs.handlers  # noqa: F401
    from app.jobs.runner import Worker
    from app.shared.runtime_tuning import get_int

    concurrency = get_int("worker_concurrency")
    poll_ms = get_int("worker_poll_ms")

    print(
        f"""
    ================================================================
    |              Report Archive Background Worker                |
    ================================================================
    |  Concurrency: {concurrency:<46}|
    |  Poll (ms):   {poll_ms:<46}|
    ================================================================
    """
    )

    worker = Worker(concurrency=concurrency, poll_ms=poll_ms)
    signal.signal(signal.SIGTERM, worker.stop)
    signal.signal(signal.SIGINT, worker.stop)
    worker.run()


if __name__ == "__main__":
    main()
