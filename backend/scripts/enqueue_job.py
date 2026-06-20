"""작업 큐에 한 건 적재하는 범용 CLI.

systemd 타이머(스케줄형 작업)나 운영자가 수동으로 워커 작업을 넣을 때 쓴다.
Job 모델은 다른 매퍼에 의존하지 않으므로 전체 모델 import 없이 가볍게 동작.

사용:
    python scripts/enqueue_job.py orphan_cleanup '{"delete": true, "grace_hours": 48}'
    python scripts/enqueue_job.py echo '{"hello": "world"}'
    python scripts/enqueue_job.py orphan_cleanup '{"delete":true}' --dedup nightly

중복 방지(--dedup KEY)를 주면 같은 (type, KEY) 가 이미 대기/처리 중일 때
조용히 건너뛴다(타이머가 매일 도는데 이전 게 안 끝났을 때 쌓이지 않게).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy.exc import IntegrityError  # noqa: E402

from app.database import SessionLocal  # noqa: E402
from app.jobs import queue  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="작업 큐에 한 건 적재")
    ap.add_argument("type", help="핸들러 종류 (예: orphan_cleanup, echo)")
    ap.add_argument(
        "payload", nargs="?", default="{}", help="JSON payload (기본 {})"
    )
    ap.add_argument("--dedup", default=None, help="중복 방지 키(type+key 단일화)")
    ap.add_argument("--priority", type=int, default=0)
    ap.add_argument("--delay", type=int, default=0, help="지연 실행(초)")
    args = ap.parse_args()

    try:
        payload = json.loads(args.payload)
        if not isinstance(payload, dict):
            raise ValueError("payload must be a JSON object")
    except ValueError as e:
        print(f"invalid payload: {e}", file=sys.stderr)
        return 2

    session = SessionLocal()
    try:
        job_id = queue.enqueue(
            session,
            args.type,
            payload,
            dedup_key=args.dedup,
            priority=args.priority,
            delay_seconds=args.delay,
        )
        session.commit()
        print(f"enqueued job {job_id} type={args.type}")
        return 0
    except IntegrityError:
        session.rollback()
        # dedup 충돌 — 이미 같은 작업이 대기/처리 중. 타이머 입장에선 정상.
        print(f"skipped: a '{args.type}' job with dedup='{args.dedup}' is already queued")
        return 0
    finally:
        session.close()


if __name__ == "__main__":
    raise SystemExit(main())
