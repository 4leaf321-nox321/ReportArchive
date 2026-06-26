"""아카이브 RAG Q&A (A, B300_보조AI_설계.md §A) — 질문 → 검색 → 인용 답변.

semantic_search 로 권한 게이팅된 상위 청크를 모아 번호 출처 프롬프트를 만들고
B300(llm.chat)에게 **출처만 근거로** 답하게 한다. 근거가 약하면(검색 0건 또는
최고 유사도 < 임계) LLM 을 호출하지 않아 환각을 막는다. 데이터 권한은
semantic_search 의 가시 scope 가 이미 보장(권한 밖 보고서는 컨텍스트에 못 들어가
인용 불가) — 기능 권한 게이트(§E)는 호출부에서 통과시킨다.
"""
from __future__ import annotations

import re

from sqlalchemy.orm import Session

from app.ai import search as ai_search
from app.ai.llm import chat
from app.config import settings

# 컨텍스트 토큰 폭주 방지 — 출처 1개당 본문 길이 상한(문자).
_MAX_CHARS_PER_SOURCE = 1200

_SYSTEM = (
    "당신은 사내 CAE 보고서 아카이브 어시스턴트다. 아래 [출처]에 있는 내용만 "
    "근거로, 한국어로 간결히 답하라. 각 주장 끝에 근거 출처를 [번호] 로 인용하라. "
    "출처에 없는 내용은 '해당 내용은 아카이브에서 찾지 못했습니다' 라고 답하고 "
    "추측하지 마라."
)

_CITE_RE = re.compile(r"\[(\d+)\]")


def ask_archive(db: Session, actor, query: str, *, limit: int = 8) -> dict:
    """질문 → {answer, citations, no_evidence, ...}. actor 는 검색 권한 scope 용
    (.user.id 기반 가시 보고서). 기능 권한 게이트는 호출부에서 이미 통과."""
    q = (query or "").strip()
    if not q:
        return {"answer": "", "citations": [], "no_evidence": True}

    # 1) 검색 — 청크 전문(snippet_chars=None) + 근거 가드 임계(min_score 재사용).
    hits = ai_search.semantic_search(
        db,
        q,
        actor,
        limit=limit,
        min_score=settings.embedding_hybrid_min_score,
        snippet_chars=None,
    )
    if not hits:
        return {
            "answer": "관련 보고서를 찾지 못했습니다.",
            "citations": [],
            "no_evidence": True,
        }

    # 2) 번호 출처 블록 + citations 메타(프론트 클릭 점프용).
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

    user_msg = "[출처]\n" + "\n\n".join(blocks) + f"\n\n질문: {q}"

    # 3) LLM 호출 — 실패(LLMError)는 위로 전파(라우트가 502). 검색·앱은 무영향.
    res = chat(
        [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": user_msg},
        ]
    )
    answer = res.content or ""

    # 4) 답변에 실제 인용된 번호만 표시용 마킹(LLM 이 누락/오기해도 출처는 전부 반환).
    used = {int(n) for n in _CITE_RE.findall(answer)}
    for c in citations:
        c["used"] = c["n"] in used

    return {
        "answer": answer,
        "citations": citations,
        "no_evidence": False,
        "model": res.model,
        "backend": res.backend,
    }
