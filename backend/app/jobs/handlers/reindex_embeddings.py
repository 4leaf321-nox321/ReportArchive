"""전체(또는 일부) 보고서 임베딩 일괄 적재 — 초기 백필/재색인용.

직접 임베딩하지 않고 보고서마다 `embed_report` 잡을 **하나씩 적재**한다. 그래야
큐가 보고서 단위로 동시성·재시도·진행상황을 관리한다(오펀 정리처럼 스케줄/온디맨드
가능). 대량이라 priority 를 낮춰 인터랙티브 잡을 굶기지 않는다. report 당 dedup_key
로 같은 보고서가 중복 적재되지 않게 한다.

payload:
    force: bool=False   (변화 없어도 강제 재임베딩 — embed_report 로 전달)
    limit: int|None     (앞 N개만 — 테스트/점진 백필용)

result:
    {reports, enqueued, skipped_already_queued}
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.jobs.queue import enqueue
from app.jobs.registry import handler
from app.modules.reports.models import Report


@handler("reindex_embeddings")
def reindex_embeddings(session: Session, payload: dict) -> dict:
    force = bool(payload.get("force", False))
    limit = payload.get("limit")

    q = select(Report.id).where(Report.deleted_at.is_(None)).order_by(Report.id)
    if isinstance(limit, int) and limit > 0:
        q = q.limit(limit)
    ids = list(session.scalars(q).all())

    enqueued = 0
    skipped = 0
    for rid in ids:
        try:
            enqueue(
                session,
                "embed_report",
                {"report_id": rid, "force": force},
                dedup_key=f"embed:{rid}",
                priority=-1,  # 대량 백필은 인터랙티브 잡보다 뒤로
            )
            session.commit()  # 건별 커밋 — dedup 충돌 시 그 1건만 롤백
            enqueued += 1
        except IntegrityError:
            session.rollback()  # 이미 같은 보고서 임베딩 잡이 대기/처리 중
            skipped += 1

    return {
        "reports": len(ids),
        "enqueued": enqueued,
        "skipped_already_queued": skipped,
    }
