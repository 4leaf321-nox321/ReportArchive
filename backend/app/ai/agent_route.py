"""복합 질문 → 에이전트 자동 라우팅 (다중홉 라우터).

`structured_qa`(집계 라우터)와 같은 계약을 미러링한다: 토글 게이트 → 무료 휴리스틱
게이트 → 디스패치-또는-폴백. `qa.ask_archive*` 가 집계 라우터(maybe_answer) **직후**
이 라우터를 부른다. 여기서 None 이면 일반 RAG 로 폴백한다.

**분류는 휴리스틱만**(v1) — 다홉/관계 신호어가 있을 때만 에이전트로 보낸다. 추가 LLM
콜이 없어, 단순 질문의 /ask 지연·비용이 늘지 않는다. (LLM 분류는 후속 여지.)

**속도 원칙**: 이 라우터는 오직 /ask(질문하기=명시적 엔터) 경로에서만 불린다. 키워드
검색은 이 경로를 안 타므로 자동 라우팅과 무관하게 항상 즉시다.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from app.config import settings

# 다홉/관계 신호어 — flat RAG 가 못 하는 "객체·관계를 여러 단계 타는" 질문의 표식.
# structured_qa._CUES 와 같은 방식(소문자 부분일치). 집계 신호어(몇·목록)와 겹치지
# 않게 관계·연쇄 표현에 집중 — 집계는 앞단 maybe_answer 가 먼저 가로챈다.
_MULTIHOP_CUES = (
    "관여한", "관여된", "담당한", "담당자", "맡은",
    "물린", "물려", "얽힌", "엮인", "연결된", "연관된",
    "거쳐", "통해", "경유", "사이", "이어지는", "연쇄",
    "공급", "납품", "협력사", "공급사",
    "가 만든", "가 작성한", "가 참여한", "와 관련된", "에 물린",
)


def _has_multihop_cue(q: str) -> bool:
    ql = q.lower()
    return any(c in ql for c in _MULTIHOP_CUES)


def _is_complex(db: Session, q: str) -> bool:
    """이 질문이 다단계(에이전트) 조사를 요하는가. v1 = 휴리스틱만(추가 LLM 0)."""
    return _has_multihop_cue(q)


def _enabled() -> bool:
    from app.modules.app_settings import store

    return bool(store.get("rag_auto_route_enabled")) and (
        (settings.llm_backend or "mock").lower() != "mock"
    )


def maybe_route_agent(db: Session, actor, query: str) -> Optional[dict]:
    """복합 질문이면 에이전트로 답(dict), 아니면 None(→ 일반 RAG).

    반환 dict 는 /ask 응답 형태로 정규화한다 — 에이전트 결과(agent._result)엔 seeds 가
    없어 프론트의 askResult.seeds 읽기가 깨질 수 있으므로 빈 리스트로 채운다.
    LLMError 등 에이전트 실행 오류는 **전파**한다(/agent 와 동일하게 502) — 조용히 RAG
    로 폴백하지 않는다(사용자가 복합 질문을 의도했는데 얕은 답을 주면 안 됨).
    """
    if not _enabled():
        return None
    q = (query or "").strip()
    if not q or not _is_complex(db, q):
        return None
    from app.ai import agent

    res = agent.run_agent(db, actor, q)
    res.setdefault("seeds", [])
    return res
