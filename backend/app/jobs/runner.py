"""워커 런타임 — 다중 스레드가 큐를 폴링/처리 + 주기 reaper.

SQLAlchemy 가 sync 모드라 동시성은 프로세스 내 스레드로 낸다. 각 스레드는
자기 SessionLocal 세션을 들고 claim→처리 루프를 돈다. SKIP LOCKED 덕분에
스레드가 같은 작업을 집지 않는다.

graceful shutdown: SIGTERM/SIGINT → stop 이벤트. 스레드는 진행 중인 작업을
마치고(새 claim 중단) 종료한다. systemd TimeoutStopSec 안에 끝나도록.
"""
from __future__ import annotations

import logging
import os
import threading
import time
import traceback

from app.database import SessionLocal
from app.jobs import queue
from app.jobs.models import DEFAULT_REAP_TIMEOUT_S
from app.jobs.registry import get_handler

logger = logging.getLogger("reportarchive.worker")


class Worker:
    def __init__(
        self,
        *,
        concurrency: int = 2,
        poll_ms: int = 1000,
        reap_interval_s: int = 60,
        reap_timeout_s: int = DEFAULT_REAP_TIMEOUT_S,
    ) -> None:
        self.concurrency = max(1, concurrency)
        self.poll_s = max(0.05, poll_ms / 1000.0)
        self.reap_interval_s = reap_interval_s
        self.reap_timeout_s = reap_timeout_s
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._id_base = f"{os.uname().nodename}:{os.getpid()}"

    # --- lifecycle ---------------------------------------------------------
    def run(self) -> None:
        logger.info(
            "worker start — concurrency=%d poll=%.2fs reap_timeout=%ds",
            self.concurrency, self.poll_s, self.reap_timeout_s,
        )
        # 부팅 시 좀비 한 번 회수(이전 크래시 잔재).
        self._reap_once()

        for i in range(self.concurrency):
            t = threading.Thread(target=self._loop, args=(i,), name=f"job-w{i}", daemon=True)
            t.start()
            self._threads.append(t)

        # 메인 스레드 = 주기 reaper + shutdown 대기.
        last_reap = time.monotonic()
        while not self._stop.is_set():
            self._stop.wait(timeout=1.0)
            if self._stop.is_set():
                break
            if time.monotonic() - last_reap >= self.reap_interval_s:
                self._reap_once()
                last_reap = time.monotonic()

        logger.info("worker stopping — draining in-flight jobs…")
        for t in self._threads:
            t.join(timeout=30)
        logger.info("worker stopped")

    def stop(self, *_args) -> None:
        self._stop.set()

    # --- internals ---------------------------------------------------------
    def _reap_once(self) -> None:
        session = SessionLocal()
        try:
            n = queue.reap_stuck(session, self.reap_timeout_s)
            if n:
                logger.warning("reaped %d stuck job(s)", n)
        except Exception:  # noqa: BLE001
            logger.exception("reaper error")
            session.rollback()
        finally:
            session.close()

    def _loop(self, idx: int) -> None:
        worker_id = f"{self._id_base}#{idx}"
        session = SessionLocal()
        try:
            while not self._stop.is_set():
                try:
                    job = queue.claim(session, worker_id)
                except Exception:  # noqa: BLE001 — claim 자체 실패(예: DB 끊김)
                    logger.exception("claim error")
                    session.rollback()
                    self._stop.wait(timeout=self.poll_s)
                    continue

                if job is None:
                    self._stop.wait(timeout=self.poll_s)
                    continue

                self._process(session, job, worker_id)
        finally:
            session.close()

    def _process(self, session, job, worker_id: str) -> None:
        logger.info("job %d type=%s attempt=%d worker=%s", job.id, job.type, job.attempts, worker_id)
        try:
            fn = get_handler(job.type)
        except KeyError as e:
            # 알 수 없는 type — 재시도해도 소용없으니 max 로 올려 즉시 종결.
            job.attempts = job.max_attempts
            queue.mark_failed(session, job, str(e))
            logger.error("job %d: %s", job.id, e)
            return

        try:
            result = fn(session, job.payload or {})
            queue.mark_done(session, job, result)
            logger.info("job %d done", job.id)
        except Exception:  # noqa: BLE001 — 핸들러 실패는 재시도/종결로 흡수
            session.rollback()  # 핸들러가 더럽힌 세션 정리 후 상태 기록
            err = traceback.format_exc()
            queue.mark_failed(session, job, err)
            logger.warning(
                "job %d failed (attempt %d/%d): %s",
                job.id, job.attempts, job.max_attempts, err.splitlines()[-1] if err else "",
            )
