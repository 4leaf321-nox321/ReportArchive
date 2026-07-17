"""온톨로지 에이전트 오케스트레이터 (tool-calling 설계 §4).

LLM이 온톨로지 도구(agent_tools)를 스스로 호출해 다단계로 조사하고, 근거와 함께
답하게 한다. 팔란티어 AIP식 — 온톨로지가 1차 검색 구조, LLM은 에이전트.

루프: chat(tools=스키마) → tool_calls 있으면 실행·되먹임(+인용/trace 누적) →
없으면 최종 답변. 도구가 만진 보고서·객체를 인용으로 모은다. 보고서 근거는
hybrid_search 가 가시성 게이팅(권한 밖 유출 X).

폭주 방지는 셋이 나눠 맡는다 — **max_hops**=LLM 왕복 수, **결과크기 상한**(agent_tools
_SEARCH_LIMIT 등)=홉당 토큰, **_MAX_TOOL_CALLS_PER_HOP/_TOTAL**=실제 도구 실행 수.
앞의 둘만으론 한 홉에 뱉은 tool_calls N개가 그대로 다 도는 걸 못 막는다.

동기 함수 — 라우트가 run_in_threadpool 로 부른다(hop 마다 sync chat). 스트리밍/
중간취소는 후속(지금은 max_hops·타임아웃으로 bound).
"""
from __future__ import annotations

import json

from sqlalchemy.orm import Session

from app.ai import agent_tools
from app.ai.llm import chat

_MAX_HOPS = 6

# ★ 홉 예산 — max_hops 는 **LLM 왕복 횟수**만 묶는다. 한 홉에서 모델이 tool_calls 를
# 몇 개든 뱉을 수 있어서, 그것만으론 실제 작업량(벡터검색 N회 등)이 안 묶인다.
# 아래 두 상한이 fan-out 을 묶는다. 초과분은 **실행만 건너뛰고 응답은 채운다** —
# tool_call 마다 tool 메시지가 있어야 하는 프로토콜이라 그냥 버리면 다음 chat 이 깨진다.
_MAX_TOOL_CALLS_PER_HOP = 6
_MAX_TOOL_CALLS_TOTAL = 20
_BUDGET_MSG = (
    "도구 호출 예산을 초과해 이 호출은 실행되지 않았습니다. "
    "지금까지 모은 근거만으로 답하세요."
)

_SYSTEM = (
    "당신은 사내 CAE 아카이브의 온톨로지 분석가다. 객체(모델·부품·과제·공급사·"
    "시험실행·실패사례 등)와 그 속성·관계, 그리고 보고서를 도구로 조사해 한국어로 "
    "간결히 답한다.\n"
    "규칙:\n"
    "1) 어휘(객체 종류 slug·속성 key·관계 slug)가 확실치 않으면 먼저 list_object_types 를 호출하라.\n"
    "2) '속성이 조건에 맞는' '특정 객체와 관계된' 같은 구조적 질문은 search_objects 로 "
    "정확히 필터하라(추측 금지). 객체 상세는 get_object. 한 객체 주변의 관계망을 "
    "여러 홉 훑어야 하면 get_object 를 반복하지 말고 get_subgraph 한 번으로 가져와라.\n"
    "3) 서술형·정성 질문이나 객체의 근거 문서가 필요하면 search_reports 로 본문을 검색하라.\n"
    "4) 도구가 반환한 사실만 근거로 답하고, 근거로 쓴 보고서·객체를 답변에 명시하라. "
    "찾지 못하면 '아카이브에서 찾지 못했습니다'라고 답하고 지어내지 마라.\n"
    "5) 필요한 조사가 끝나면 도구를 더 부르지 말고 최종 답변을 작성하라."
)


def _assistant_tool_msg(res) -> dict:
    """파싱된 tool_calls 를 OpenAI assistant 메시지로 재구성(다음 턴에 되먹임)."""
    return {
        "role": "assistant",
        "content": res.content or "",
        "tool_calls": [
            {
                "id": tc.get("id") or f"call_{i}",
                "type": "function",
                "function": {
                    "name": tc.get("name"),
                    "arguments": json.dumps(tc.get("arguments") or {}, ensure_ascii=False),
                },
            }
            for i, tc in enumerate(res.tool_calls)
        ],
    }


def _summary(tool: str, args: dict, content: dict) -> str:
    """추론 과정 표시용 한 줄 요약."""
    if content.get("error"):
        return f"{tool} → 오류: {content['error']}"
    if tool == "list_object_types":
        return "온톨로지 지도 조회"
    if tool == "search_objects":
        return f"객체 검색(종류={args.get('type') or '전체'}) → {content.get('total', '?')}건"
    if tool == "get_object":
        return f"객체 조회 {args.get('type')}:{args.get('id')} → {content.get('label', '')}"
    if tool == "search_reports":
        return f"보고서 검색 → {content.get('count', 0)}건"
    if tool == "aggregate_reports":
        conds = " · ".join(args.get("filters") or []) or "전체"
        return f"집계({conds}) → {content.get('count', '?')}{content.get('unit', '건')}"
    return tool


# 주입하는 이전 턴 1개당 본문 상한(토큰 폭주 방지). 긴 답변은 잘라서 넣는다.
_MAX_HIST_CONTENT = 1500


def _history_messages(history) -> list[dict]:
    """대화 히스토리 [{role,content}] → 에이전트 message 로 정제(역할 검증·본문 상한).
    이걸 system 과 현재 질문 사이에 넣어 에이전트가 다단계 추론 내내 전체 맥락을 본다."""
    if not history:
        return []
    out = []
    for m in history:
        role = (m or {}).get("role")
        content = ((m or {}).get("content") or "").strip()
        if role in ("user", "assistant") and content:
            out.append({"role": role, "content": content[:_MAX_HIST_CONTENT]})
    return out


def run_agent(db: Session, actor, query: str, *, history=None,
              max_hops: int = _MAX_HOPS) -> dict:
    """질문 → {answer, citations, objects, trace, no_evidence, model, backend}.

    actor 는 도구 실행 권한(보고서 가시성) scope 용. 기능 게이트는 호출부에서 통과.
    history(대화 이전 턴 [{role,content}])가 있으면 (1) 후속 질문을 독립형으로 재작성하고
    (rewritten_query 로 노출), (2) 이전 턴을 message 로 통째 주입해 다단계 추론 내내
    전체 맥락을 본다(대화형 검색)."""
    from app.ai import qa

    q = (query or "").strip()
    if not q:
        return _result("", [], [], [], no_evidence=True)

    # 대화 맥락 재작성 — 후속("그 중 2024년만?")을 독립형 질문으로. 첫 턴이면 그대로.
    standalone = qa._contextualize(history, q)

    # 이전 대화 턴을 통째로 주입 → 에이전트가 다단계 추론 내내 전체 맥락을 본다
    # (재작성된 현재 질문 + 이전 Q&A). 첫 턴이면 히스토리 없음.
    messages = [
        {"role": "system", "content": _SYSTEM},
        *_history_messages(history),
        {"role": "user", "content": standalone},
    ]
    trace: list[dict] = []
    reports: dict[int, dict] = {}   # report_id → citation(중복 제거)
    objects: dict[str, dict] = {}   # "type:id" → object(중복 제거)
    last = None
    spent = 0                       # 누적 도구 실행 수(_MAX_TOOL_CALLS_TOTAL 예산)

    for hop in range(1, max_hops + 1):
        # 마지막 hop 은 도구 없이 답변 강제(무한 조사 방지).
        use_tools = hop < max_hops
        last = chat(
            messages,
            tools=agent_tools.TOOL_SCHEMAS if use_tools else None,
        )
        if not (use_tools and last.tool_calls):
            break

        messages.append(_assistant_tool_msg(last))
        for idx, tc in enumerate(last.tool_calls):
            name, args = tc.get("name"), (tc.get("arguments") or {})
            if idx >= _MAX_TOOL_CALLS_PER_HOP or spent >= _MAX_TOOL_CALLS_TOTAL:
                content = {"error": _BUDGET_MSG}
            else:
                spent += 1
                result = agent_tools.run_tool(db, actor, name, args)
                content = result.get("content", {})
                for o in result.get("objects", []):
                    objects[f"{o['type']}:{o['id']}"] = o
                for r in result.get("reports", []):
                    reports.setdefault(r["report_id"], r)
                trace.append({"hop": hop, "tool": name, "args": args,
                              "summary": _summary(name, args, content)})
            messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id") or f"call_{hop}",
                "content": json.dumps(content, ensure_ascii=False),
            })

    citations = [
        {"n": i, **r} for i, r in enumerate(reports.values(), start=1)
    ]
    result = _result(
        last.content if last else "",
        citations,
        list(objects.values()),
        trace,
        no_evidence=not citations and not objects,
        model=getattr(last, "model", None),
        backend=getattr(last, "backend", None),
    )
    # 근거 검증 — 질문하기와 동일 레이어 재사용. 전역 'rag_verify_enabled' 설정이 켜져
    # 있을 때만(mock 무효). 도구가 만진 보고서 인용을 [번호] 블록으로 재구성해 답변의
    # 각 주장이 실제 근거에 뒷받침되는지 사후 판정한다. 보강 레이어라 실패해도 무해.
    blocks = _verify_blocks(citations)
    if blocks and qa._verify_enabled():
        v = qa._verify(result["answer"], blocks)
        if v:
            result["verification"] = v
    # 후속 질문이 재작성됐으면 노출 — 프론트가 "(이렇게 이해했어요)"로 표시.
    if standalone != q:
        result["rewritten_query"] = standalone
    return result


def _verify_blocks(citations: list[dict]) -> list[str]:
    """근거 검증용 [번호] 출처 블록. 본문(snippet)이 있는 보고서 인용만 — 객체·집계
    인용은 검증할 원문이 없어 제외. 인용 n 을 그대로 써 _verify 의 source 번호와 맞춘다."""
    blocks = []
    for c in citations:
        snippet = (c.get("snippet") or "").strip()
        if not snippet:
            continue
        head = f"보고서: {c.get('title') or c.get('report_id')}"
        blocks.append(f"[{c['n']}] ({head})\n{snippet}")
    return blocks


def _result(answer, citations, objects, trace, *, no_evidence,
            model=None, backend=None) -> dict:
    return {
        "answer": answer or "",
        "citations": citations,
        "objects": objects,
        "trace": trace,
        "no_evidence": no_evidence,
        "model": model,
        "backend": backend,
    }


async def run_agent_stream(db, actor, query: str, *, history=None,
                           max_hops: int = _MAX_HOPS, should_cancel=None):
    """run_agent 의 스트리밍 버전 — 진행 상황 + 최종 답변 토큰을 이벤트로 yield.

    이벤트 dict: {type:'rewrite'|'progress'|'token'|'done', ...}. 도구 조사(sync·DB)는
    threadpool 로, 최종 답변은 astream_chat 로 토큰 단위 스트리밍(tools 없이). 도구가
    끝나면(또는 max_hops) Phase 2 에서 근거를 바탕으로 답을 생성·스트리밍한다.
    should_cancel: 비동기 콜백(연결 끊김) — True 면 중단."""
    from starlette.concurrency import run_in_threadpool

    from app.ai import qa
    from app.ai.llm import astream_chat

    q = (query or "").strip()
    if not q:
        yield {"type": "done", "answer": "", "citations": [], "objects": [],
               "trace": [], "no_evidence": True}
        return

    standalone = qa._contextualize(history, q)
    if standalone != q:
        yield {"type": "rewrite", "query": standalone}

    messages = [
        {"role": "system", "content": _SYSTEM},
        *_history_messages(history),
        {"role": "user", "content": standalone},
    ]
    trace: list[dict] = []
    reports: dict[int, dict] = {}
    objects: dict[str, dict] = {}
    spent = 0                       # run_agent 와 같은 도구 예산(_MAX_TOOL_CALLS_TOTAL)

    # Phase 1 — 도구 조사(진행 상황 방출). 최종 답변은 Phase 2 에서 스트리밍.
    for hop in range(1, max_hops):
        if should_cancel and await should_cancel():
            return
        last = await run_in_threadpool(
            chat, messages, tools=agent_tools.TOOL_SCHEMAS,
        )
        if not last.tool_calls:
            break
        messages.append(_assistant_tool_msg(last))
        for idx, tc in enumerate(last.tool_calls):
            name, args = tc.get("name"), (tc.get("arguments") or {})
            if idx >= _MAX_TOOL_CALLS_PER_HOP or spent >= _MAX_TOOL_CALLS_TOTAL:
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id") or f"call_{hop}",
                    "content": json.dumps({"error": _BUDGET_MSG}, ensure_ascii=False),
                })
                continue
            spent += 1
            result = await run_in_threadpool(agent_tools.run_tool, db, actor, name, args)
            content = result.get("content", {})
            for o in result.get("objects", []):
                objects[f"{o['type']}:{o['id']}"] = o
            for r in result.get("reports", []):
                reports.setdefault(r["report_id"], r)
            summary = _summary(name, args, content)
            trace.append({"hop": hop, "tool": name, "args": args, "summary": summary})
            messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id") or f"call_{hop}",
                "content": json.dumps(content, ensure_ascii=False),
            })
            yield {"type": "progress", "summary": summary}

    # Phase 2 — 최종 답변 토큰 스트리밍(tools 없음).
    yield {"type": "progress", "summary": "답 정리 중…"}
    answer_parts: list[str] = []
    async for tok in astream_chat(messages, should_cancel=should_cancel):
        answer_parts.append(tok)
        yield {"type": "token", "text": tok}
    answer = "".join(answer_parts).strip()

    citations = [{"n": i, **r} for i, r in enumerate(reports.values(), start=1)]
    result_objects = list(objects.values())
    done = {
        "type": "done", "answer": answer, "citations": citations,
        "objects": result_objects, "trace": trace,
        "no_evidence": not citations and not result_objects,
    }
    if standalone != q:
        done["rewritten_query"] = standalone
    blocks = _verify_blocks(citations)
    if blocks and qa._verify_enabled():
        v = await run_in_threadpool(qa._verify, answer, blocks)
        if v:
            done["verification"] = v
    yield done
