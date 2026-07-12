"""작업 핸들러 모음.

이 패키지를 import 하면 아래 모듈들이 로드되며 @handler 데코레이터가
registry.JOB_HANDLERS 를 채운다. 워커(worker.py)가 부팅 시 한 번 import 한다.

echo: self-test(레일 점검). orphan_cleanup: 고아 업로드 정리(첫 도메인 핸들러).
"""
from __future__ import annotations

from app.jobs.handlers import echo  # noqa: F401  (등록 부작용)
from app.jobs.handlers import orphan_cleanup  # noqa: F401  (등록 부작용)
from app.jobs.handlers import embed_report  # noqa: F401  (등록 부작용)
from app.jobs.handlers import reindex_embeddings  # noqa: F401  (등록 부작용)
from app.jobs.handlers import summarize_report  # noqa: F401  (등록 부작용)
from app.jobs.handlers import send_email  # noqa: F401  (등록 부작용)
from app.jobs.handlers import sync_data_source  # noqa: F401  (등록 부작용)
from app.jobs.handlers import run_alert_rule  # noqa: F401  (등록 부작용)
