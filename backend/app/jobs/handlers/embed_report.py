"""보고서 1건 임베딩 핸들러 — 청크 분해 → 임베딩 → report_chunks 저장.

재임베딩은 "교체"(해당 report_id 청크 전부 삭제 후 새로 삽입)다. content_hash
가 직전과 같으면(본문 변화 없음) 임베딩 호출을 건너뛴다(force=true 로 무시 가능).
소프트삭제(deleted_at)된 보고서는 임베딩하지 않고 기존 청크를 제거한다.

payload:
    report_id: int   (필수)
    force: bool=False  (content_hash 동일해도 강제 재임베딩)

result:
    {report_id, chunks, skipped?, content_hash?}
"""
from __future__ import annotations

import hashlib

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.ai.embeddings import embed_texts
from app.ai.models import ReportChunk
from app.config import settings
from app.jobs.registry import handler
from app.modules.reports.models import Report
from app.widgets.text_extraction import extract_chunks_for_report


def _delete_chunks(session: Session, report_id: int) -> None:
    session.execute(delete(ReportChunk).where(ReportChunk.report_id == report_id))


@handler("embed_report")
def embed_report(session: Session, payload: dict) -> dict:
    report_id = int(payload["report_id"])
    force = bool(payload.get("force", False))

    report = session.get(Report, report_id)
    if report is None:
        return {"report_id": report_id, "chunks": 0, "skipped": "not_found"}

    # 소프트삭제: 임베딩 대상 아님 — 검색에 새면 안 되므로 청크 제거.
    if getattr(report, "deleted_at", None) is not None:
        _delete_chunks(session, report_id)
        session.commit()
        return {"report_id": report_id, "chunks": 0, "skipped": "deleted"}

    chunks = extract_chunks_for_report(report)
    texts = [c.text for c in chunks]
    # 본문뿐 아니라 임베딩 백엔드/모델/차원도 해시에 포함 — mock→ollama 전환이나
    # 모델 교체 시 "변화 없음" 으로 오인해 옛 벡터를 유지하지 않도록.
    fingerprint = (
        f"{settings.embedding_backend}:{settings.embedding_model}:{settings.embedding_dim}"
    )
    content_hash = hashlib.sha256(
        (fingerprint + "\n" + "\n".join(texts)).encode("utf-8")
    ).hexdigest()

    # 변화 없으면 스킵(이미 같은 해시로 임베딩됨).
    if not force and texts:
        existing = session.scalar(
            select(ReportChunk.content_hash)
            .where(ReportChunk.report_id == report_id)
            .limit(1)
        )
        if existing == content_hash:
            return {
                "report_id": report_id,
                "chunks": len(texts),
                "skipped": "unchanged",
            }

    # 교체: 기존 청크 삭제.
    _delete_chunks(session, report_id)

    if not texts:
        session.commit()
        return {"report_id": report_id, "chunks": 0}

    vectors = embed_texts(texts)  # 실패 시 EmbeddingError → 큐가 재시도
    # 청크↔객체 링크 — L0(결정적 경계매칭) ∪ L1(임베딩 유사도, mock 이면 빈). p74.
    from app.modules.entities.autotag import (
        build_term_index,
        entity_ids_in_text,
        l1_chunk_entity_links,
    )

    term_index = build_term_index(session)
    l1_links = l1_chunk_entity_links(session, vectors)  # 청크별 L1
    for idx, (c, vec) in enumerate(zip(chunks, vectors)):
        eids = sorted(set(entity_ids_in_text(c.text, term_index)) | set(l1_links[idx]))
        session.add(
            ReportChunk(
                report_id=report_id,
                chunk_index=idx,
                page_idx=c.page_idx,
                block_id=c.block_id,
                widget_type=c.widget_type,
                text=c.text,
                embedding=vec,
                entity_ids=eids,
                content_hash=content_hash,
            )
        )
    session.commit()
    return {
        "report_id": report_id,
        "chunks": len(texts),
        "content_hash": content_hash[:12],
    }
