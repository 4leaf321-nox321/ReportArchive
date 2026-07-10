# 온톨로지 에이전트 — 팔란티어식 tool-calling (설계 스케치)

> 상태: **구현 완료 (v0.74.0)** — 커밋 `4397c76`. 도구 4종(list_object_types·
> search_objects·get_object·search_reports) + 에이전트 루프(`app/ai/agent.py`,
> `agent_tools.py`) + `POST /api/ai/agent`. 검색 「에이전트」 모드로 노출. 이후
> **MCP로도 노출**(v0.76.0, `[완료] MCP온톨로지조사_설계.md`) — 외부 AI도 스스로 조사.
> *(운영 GLM 함수호출은 `scripts/check_tool_calling.py`로 확인 권장; 미지원 시 단일답변 degrade.)*
>
> 팔란티어 AIP의 핵심: **온톨로지가 1차 검색 구조이고, LLM은 그 위에서 도구를
> 호출하는 에이전트**다. 벡터 유사도로 청크를 긁는 게 아니라, LLM이 "객체 검색
> → 링크 traversal → 속성 필터"를 **함수 호출로 스스로 계획**한다. 속성·링크는
> 결정적(정확), 벡터는 진입점 하나. GraphRAG(v0.73.0, 벡터-보강)와 배타 아님 —
> `search_reports`를 도구로 넣으면 합쳐진다.

## 0. 지금 GraphRAG와 무엇이 다른가

| | GraphRAG (v0.73.0) | 온톨로지 에이전트 (이 설계) |
|---|---|---|
| 파이프라인 | 고정(질문→벡터검색→답) | LLM이 도구 호출로 **동적 계획** |
| 그래프 | 벡터결과 재랭킹·보강 | **1차 검색 구조** |
| 정확도 | 전부 퍼지 | 속성·링크 결정적, 벡터는 진입점 |
| 구조적 질문 | 약함("RPN>100인 부품"?) | 강함(정확 필터·집계·다단계) |
| 텍스트-무관 이웃 | 못 가져옴 | 링크로 바로 가져옴 |

## 1. 아키텍처 — 에이전트 루프

```
system: 온톨로지 지도(타입·속성·관계 목록) + 도구 사용 규칙
user:   질문
 └─ 루프 (최대 _MAX_HOPS=6, 취소가능):
      res = chat(messages, tools=TOOLS)
      ├─ tool_calls 있음 → 각 호출을 dispatch(권한 게이팅) → tool 결과를
      │   messages 에 append(+provenance 누적) → 다음 hop
      └─ tool_calls 없음 → 최종 답변 → finalize(답변 + 인용 + 추론 trace)
```
OpenAI 프로토콜: assistant(tool_calls) 메시지를 먼저 넣고, 이어서 각
`role:"tool"` 결과를 넣는다.

## 2. 도구 카탈로그 (전부 기존 서비스에 매핑 — 신규 로직 최소)

| 도구 | 목적 | 기존 서비스 |
|---|---|---|
| `list_object_types` | 온톨로지 지도(어떤 타입·속성·관계가 있나) | `list_entity_types` + property_defs + `list_relation_types` |
| `search_objects(type, props[], relations[], q)` | 타입+속성+관계로 객체 검색(결정적) | **`search_entities` (Phase C 그대로)** |
| `get_object(type, id)` | 객체 프로필(속성·관계·근거·관련보고서) | `resolve_object` + `get_entity_profile` |
| `get_linked_objects(type, id, relation?, direction?)` | 링크 이웃(관계별·방향) | `list_relations`/`graph.neighbors`/object_links |
| `search_reports(query)` | 텍스트/의미 근거 검색(=벡터 RAG를 도구화) | **`hybrid_search`** |
| `get_report_excerpt(report_id, query?)` | 보고서 본문 발췌 | `report_chunks` / 콘텐츠 |

- `list_object_types` 가 핵심 — LLM이 어휘(타입 slug·속성 key·관계 slug)를 알아야
  올바른 쿼리를 만든다. 시스템 프롬프트에 **요약본**을 넣고, 상세는 이 도구로.
- (후속) `aggregate_objects(type, filter, group_by)` 집계/롤업.
- (Phase E) `apply_action(...)` write-back — 과제 생성·상태 변경. **MVP 제외**(읽기 전용).

## 3. LLM 레이어 변경 (`app/ai/llm.py`) — 척추

현재 `chat`은 tools 미지원. 추가:
- `chat(..., tools: list[dict] | None, tool_choice="auto")` — openai 페이로드에
  `tools` 실음(`_chat_openai`/스트림 경로).
- `ChatResult` 에 `tool_calls: list[{id, name, arguments}]` 필드 추가
  (`_parse_openai_response` 가 `message.tool_calls` 파싱). content 만 쓰던
  기존 호출부는 무영향(기본 None).
- **mock 백엔드**: 스크립트형 tool-calling(테스트용) — 큐에 담긴 (tool_calls|content)
  시퀀스를 순서대로 반환하는 결정적 fake. 실 B300(openai 호환, vLLM/sglang)은
  모델이 function-calling 지원 시 그대로 동작(GLM/Qwen 등 지원). 미지원 백엔드는
  graceful degrade(도구 없이 1턴).

## 4. 오케스트레이터 (`app/ai/agent.py` 신규)

`run_agent(db, actor, query, *, max_hops=6, should_cancel=None) -> dict`
- 루프 + dispatch 테이블(`{tool_name: 실행함수}`). 각 실행함수는 `actor` 를 받아
  **권한 게이팅**.
- provenance 누적: `search_objects`/`get_object` → 객체 인용, `search_reports`/
  `get_report_excerpt` → 보고서 인용(작성자·날짜·workspace, 기존 citation 재사용).
- **결과 크기 상한**: 도구 결과를 LLM에 통째로 안 준다 — 상위 N + total 카운트로
  요약(예: search_objects → 상위 10 + "총 42건"). 토큰 폭주·환각 방지.
- 반환: `{answer, citations, objects_touched, trace:[{hop, tool, args, summary}],
  no_evidence, model, backend}`.

## 5. 권한·안전

- **객체(entities)**: 전역 온톨로지 → 읽기 허용.
- **보고서**: `search_reports`/`get_report_excerpt` 는 반드시 가시성 게이팅
  (`hybrid_search` 내장 scope / `all_visible_report_ids`). 권한 밖 보고서는
  도구 결과·인용에 못 들어감.
- **읽기 전용**(MVP) — write 도구 없음.
- **캡**: `_MAX_HOPS`, 총 도구호출 수, 도구별 결과 크기, 토큰 예산, 타임아웃.
  hop 초과 시 마지막에 "지금까지 정보로만 답하라" 강제.
- 취소: hop 사이 `should_cancel` 체크(연결 끊기면 중단).

## 6. 배치

- **엔드포인트**: `POST /api/ai/agent` (신규 — 응답이 trace 포함이라 /ask와 형태
  다름). 게이트는 기존 `rag_qa` 엔티틀먼트 재사용(MVP). 취소는 `request.is_disconnected`.
- **프론트**: 검색 Q&A에 **"에이전트" 모드**(또는 그래프 토글 옆 3번째 옵션).
  최종 답변 + 접이식 **"추론 과정"**(어떤 객체·보고서를 어떻게 찾았는지 trace) +
  인용(기존 렌더 재사용, 객체 인용은 객체 프로필로 링크).

## 7. MVP 범위 vs 후속

- **MVP**: §3(llm tools) + §4(6개 읽기도구 루프) + §6(엔드포인트·에이전트 모드).
  신규 테이블 0.
- **후속**: `aggregate_objects` 집계 · 답변 스트리밍(hop별 trace 이벤트) · 전용
  `agent_qa` 엔티틀먼트 · **Actions write-back(Phase E)** · AGE 그래프DB(D-3)로
  traversal 백엔드 교체(도구 시그니처 불변).

## 8. 검증

- `tests/test_agent.py`: `chat` 을 스크립트형 fake로 주입 — 질문 → LLM이
  `search_objects` 호출 → 실제 `search_entities` 실행·결과 관찰 → 최종 답변.
  dispatch가 실서비스 호출하는지, 인용/ trace 누적, 권한 게이팅(권한 밖 보고서
  배제), hop 캡을 단언. mock 백엔드 기준.
- 프론트 eslint + esbuild.

## 9. 결정 (확정) + 구현 상태

**결정**: ① 도구 **4개**로 시작(list_object_types·search_objects·get_object·
search_reports) ② 신규 **`POST /api/ai/agent`** ③ **추론 과정(trace) 노출**
④ 운영 B300=**GLM 5.2**(function-calling 지원 확실) — 운영 스파이크로 최종 확인.

**구현 완료 (미커밋, mock 검증)**:
- `app/ai/llm.py` — `ChatResult.tool_calls`, `chat(tools=, tool_choice=)`,
  `_parse_openai_response`가 tool_calls 파싱(+ `_parse_tool_calls`). content 없이
  tool_calls만 있어도 통과. 기존 호출부 무영향.
- `app/ai/agent_tools.py` — 도구 4종 스키마 + executor + `run_tool` dispatch,
  결과 크기 상한, 보고서 가시성 게이팅.
- `app/ai/agent.py` — `run_agent` 루프(hop≤6, 마지막 hop 도구 없이 답변 강제),
  인용/객체/trace 누적, no_evidence.
- `app/modules/ai/routes.py` — `POST /api/ai/agent`(rag_qa 게이트, threadpool).
- 프론트 `askAgent` + 검색 "에이전트" 모드(답변 + 관련 객체 칩 + 접이식 추론
  과정 + 출처).
- `tests/test_agent.py` — 스크립트형 fake chat 주입, 도구 실행·trace·no_evidence (통과).

**운영 게이트 (남음)**: `scripts/check_tool_calling.py` 를 **운영에서 1회 실행** →
GLM 5.2가 tool_calls 를 내보내는지 확인 → 통과 시 릴리스. (미지원이면 degrade
경로로 무해하나 에이전트 모드는 값이 없음.)

## 10. 후속

`aggregate_objects` 집계 · get_linked_objects 전용 도구 · 답변/ trace 스트리밍 ·
중간취소(should_cancel) · 전용 `agent_qa` 엔티틀먼트 · **Actions write-back
(Phase E)** · AGE(D-3)로 traversal 백엔드 교체(도구 시그니처 불변) · 출처에
작성자·날짜(qa._hydrate_authors 재사용).
