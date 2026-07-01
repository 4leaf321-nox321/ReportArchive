"""아카이브 RAG Q&A (A, B300_보조AI_설계.md §A) — 질문 → 검색 → 인용 답변.

hybrid_search(시맨틱 벡터 + pg_trgm 키워드 RRF)로 권한 게이팅된 상위 청크를
모아 번호 출처 프롬프트를 만들고 B300(llm.chat)에게 **출처만 근거로** 답하게
한다. 하이브리드라 품번·코드·고유명사 같은 정확매치 질문도 누락 없이 근거로
끌어온다(시맨틱 단독이 약한 부분). 근거가 약하면(검색 0건) LLM 을 호출하지 않아
환각을 막는다. 데이터 권한은 hybrid_search 의 가시 scope 가 이미 보장(권한 밖
보고서는 컨텍스트에 못 들어가 인용 불가) — 기능 권한 게이트(§E)는 호출부에서
통과시킨다.
"""
from __future__ import annotations

import re

from typing import Optional

from sqlalchemy.orm import Session

from app.ai import search as ai_search
from app.ai.llm import CancelCheck, chat, chat_cancellable

# 컨텍스트 토큰 폭주 방지 — 출처 1개당 본문 길이 상한(문자).
_MAX_CHARS_PER_SOURCE = 1200

_SYSTEM = (
    "당신은 사내 CAE 보고서 아카이브 어시스턴트다. 아래 [출처]에 있는 내용만 "
    "근거로, 한국어로 간결히 답하라. 각 주장 끝에 근거 출처를 [번호] 로 인용하라. "
    "출처에 없는 내용은 '해당 내용은 아카이브에서 찾지 못했습니다' 라고 답하고 "
    "추측하지 마라."
)

_CITE_RE = re.compile(r"\[(\d+)\]")


def _retrieve(db: Session, actor, query: str, *, limit: int):
    """질문 → (질문문, citations, blocks) 또는 근거 없음 dict.

    검색(hybrid_search) 결과를 번호 출처 블록·citations 메타로 가공한다.
    동기/비동기 ask 양쪽이 공유한다. 근거가 약하면 곧장 no_evidence dict 를
    반환하고, 충분하면 (q, citations, blocks) 튜플을 준다."""
    q = (query or "").strip()
    if not q:
        return {"answer": "", "citations": [], "no_evidence": True}

    # 하이브리드(시맨틱+키워드 RRF) + 청크 전문(snippet_chars=None). 시맨틱 측
    # 근거 가드 임계(embedding_hybrid_min_score)는 hybrid_search 내부 적용.
    hits = ai_search.hybrid_search(
        db,
        q,
        actor,
        limit=limit,
        snippet_chars=None,
    )
    if not hits:
        return {
            "answer": "관련 보고서를 찾지 못했습니다.",
            "citations": [],
            "no_evidence": True,
        }

    citations, blocks = [], []
    for i, h in enumerate(hits, start=1):
        full = h.get("snippet") or ""
        title = h.get("title") or f"보고서 {h['report_id']}"
        blocks.append(f"[{i}] (보고서: {title})\n{full[:_MAX_CHARS_PER_SOURCE]}")
        citations.append(
            {
                "n": i,
                "report_id": h["report_id"],
                "title": h.get("title"),
                "workspace_slug": h.get("workspace_slug"),
                "block_id": h.get("block_id"),
                "page_idx": h.get("page_idx"),
                "snippet": full[:200],
            }
        )
    return q, citations, blocks


def _qa_messages(q: str, blocks: list[str]) -> list[dict]:
    user_msg = "[출처]\n" + "\n\n".join(blocks) + f"\n\n질문: {q}"
    return [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": user_msg},
    ]


def _finalize(answer: str, citations: list[dict], res) -> dict:
    # 답변에 실제 인용된 번호만 표시용 마킹(LLM 이 누락/오기해도 출처는 전부 반환).
    used = {int(n) for n in _CITE_RE.findall(answer or "")}
    for c in citations:
        c["used"] = c["n"] in used
    return {
        "answer": answer or "",
        "citations": citations,
        "no_evidence": False,
        "model": res.model,
        "backend": res.backend,
    }


def ask_archive(db: Session, actor, query: str, *, limit: int = 8) -> dict:
    """질문 → {answer, citations, no_evidence, ...}. actor 는 검색 권한 scope 용
    (.user.id 기반 가시 보고서). 기능 권한 게이트는 호출부에서 이미 통과."""
    retrieved = _retrieve(db, actor, query, limit=limit)
    if isinstance(retrieved, dict):
        return retrieved
    q, citations, blocks = retrieved
    # LLM 호출 — 실패(LLMError)는 위로 전파(라우트가 502). 검색·앱은 무영향.
    res = chat(_qa_messages(q, blocks))
    return _finalize(res.content or "", citations, res)


async def ask_archive_cancellable(
    db: Session,
    actor,
    query: str,
    *,
    limit: int = 8,
    should_cancel: Optional[CancelCheck] = None,
) -> dict:
    """ask_archive 의 비동기·취소 가능 버전(라우트가 클라이언트 연결 끊김을
    should_cancel 로 넘긴다). 검색은 동기지만 짧고, 긴 LLM 생성만 스트리밍해
    중간 취소된다. 결과 형태는 ask_archive 와 동일."""
    retrieved = _retrieve(db, actor, query, limit=limit)
    if isinstance(retrieved, dict):
        return retrieved
    q, citations, blocks = retrieved
    res = await chat_cancellable(_qa_messages(q, blocks), should_cancel=should_cancel)
    return _finalize(res.content or "", citations, res)
