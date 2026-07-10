# MCP 온톨로지 조사 설계 — 외부 AI의 자율 온톨로지 탐색

> 상태: **미구현** (설계 확정)
> 목표: 외부 AI(Claude 등)가 MCP를 통해 **온톨로지 구조를 스스로 조사**해 보고서/객체 질문에 답하게 한다.
> 관련: [완료] MCP보고서작성_설계.md · [미구현] 온톨로지 에이전트_tool-calling_설계.md · [일부] 엔티티그래프_온톨로지_설계.md

---

## 1. 배경 / 문제

현재 외부 AI가 MCP로 받는 "조사·검색" 도구는 얕다:

- `search_reports` → `/api/reports/search/semantic` (순수 hybrid: 키워드+임베딩)
- `describe_metadata` → 온톨로지 축·값의 **평면 목록**(작성 시 `entity_ids` 채우기용)
- `get_report` → 보고서 상세

그래서 **가능한 것**은 "값 목록 참고 → 검색 반복"의 얕은 에이전트 루프뿐이다.
**불가능한 것**:

1. **관계 그래프 traversal이 MCP에 없다.** `describe_metadata`는 축·값의 *평면 목록*만 주고,
   `part_of`·관련 엔티티·재귀 트래버설(백엔드엔 D-2로 구현됨)은 도구로 안 뚫려 있어,
   "A모델 → 속한 플랫폼 → 그와 연결된 부품들의 보고서"처럼 **구조를 타고 넘어가는 조사**를 못 한다.
2. **`search_reports`가 백엔드 지능화 검색(그래프 결합·에이전트)이 아니라 순수 hybrid만 부른다.**
   내부 에이전트(`app/ai/agent.py`)와 온톨로지 도구는 존재하지만 MCP 경유로는 호출 안 됨.

---

## 2. 결정적 사실 — 백엔드는 이미 다 있다

두 설계 모두 **백엔드 로직은 완비**돼 있고, **MCP 노출(얇은 래퍼)만** 하면 된다.

| 계층 | 자산 | 위치 |
|---|---|---|
| 내부 에이전트 오케스트레이터 | `run_agent()` — 다단계 tool-calling, 인용/trace 누적, `max_hops` bound | `backend/app/ai/agent.py:73` |
| 온톨로지 도구 4종 (LLM용, compact · size-cap · 가시성 게이팅) | `list_object_types / search_objects / get_object / search_reports` | `backend/app/ai/agent_tools.py` |
| 지능화 검색 HTTP | `POST /api/ai/agent` `{query, max_hops}` → `{answer, citations, objects, trace, no_evidence}` | `backend/app/modules/ai/routes.py:163` |
| 그래프 프리미티브 HTTP | `/api/entities/search`, `/api/entities/{id}/profile`, `/api/entities/{id}/subgraph?depth=`, `/api/entity-types`, `/api/relation-types` | `backend/app/modules/entities/routes.py` |

`agent_tools`의 실행기는 이미 다음을 내장한다: **slug→id 해석, 결과 size-cap(15/8/25), 보고서 가시성 게이팅, LLM친화적 compact shape.** 외부 에이전트에게도 그대로 재사용한다 — 재구현 0.

---

## 3. 두 설계 (상호보완)

경쟁이 아니라 **둘 다 노출**하는 것을 추천한다.

- **설계 A** = 외부(강한) AI가 *스스로* 조사한다 → 프리미티브 도구 노출, Claude가 에이전트.
- **설계 B** = 외부 AI가 자연어로 던지면 *서버 내부 LLM*이 알아서 조사해 완결 답변을 준다 → 위임.

A 없이 B만 하면 외부 AI가 서버 LLM 품질에 갇히고, B 없이 A만 하면 간단 질의도 매번 다단계 왕복이라 비싸다.

---

## 4. 설계 A — 온톨로지 프리미티브 도구 노출 (외부 AI = 에이전트)

질문의 본질("에이전트처럼 스스로 온톨로지 구조를 타고 조사")에 직접 대응.

**핵심 아이디어: `agent_tools`의 실행기를 그대로 HTTP로 뚫고, MCP에서 1:1 노출.**
내부 에이전트가 쓰는 바로 그 도구를 외부 에이전트에게도 준다.

### 4.1 백엔드 (신규 ~15줄)

```
POST /api/ai/ontology/tool     body: { name: str, args: dict }
  → agent_tools.run_tool(db, actor, name, args)["content"]
  auth : 기존 PAT (get_current_user)
  gate : 인증-only (엔티틀먼트 불필요)
         └ 근거: /api/entities/* 가 이미 "인증-only"이고,
           도구 내부 report 검색은 hybrid_search 가 가시성 게이팅한다.
           LLM을 호출하지 않으므로 rag_qa 게이트가 필요 없음.
  whitelist : {list_object_types, search_objects, get_object} 만 통과,
              나머지(create/update 계열)는 404 — 실행기 화이트리스트.
```

### 4.2 MCP 신규 도구 3종 (`mcp_server/server.py`)

```python
@mcp.tool() list_object_types()                                        # 온톨로지 지도: 타입·속성key·데이터타입(enum)·관계slug
@mcp.tool() search_objects(type, q?, props?, relations?, year?, limit?) # 결정적 구조 필터
@mcp.tool() get_object(type, id)                                        # ★ 속성 + 관계(방향/상대) + 관련보고서 = traversal 핵심
```

- `search_reports`(의미검색)는 **이미 MCP에 있음 → 재사용**. 그래서 신규는 3개뿐.
- 도크스트링에 내부 `_SYSTEM` 규칙을 이식하여 외부 Claude가 루프를 스스로 돌게 한다:
  1. 어휘(타입 slug·속성 key·관계 slug)가 불확실 → **먼저 `list_object_types`**.
  2. "속성이 조건에 맞는" / "특정 객체와 관계된" 같은 구조적 질문 → **`search_objects`** (추측 금지).
  3. 객체 상세·관계·근거문서 → **`get_object`**.
  4. 서술형·정성 질문 → **`search_reports`**.
- 필터 DSL을 스키마에 명시(내부 `_PROP_FILTER`/`_REL_FILTER` 그대로):
  - `props`: `[{key, op, value}]`, `op ∈ {eq, gte, lte, between, contains}`
  - `relations`: `[{relation, dst_id}]` — 이 관계로 `dst_id` 객체와 연결된 것만.

### 4.3 (선택·추천) 다중 hop 그래프 도구

`get_object`는 1-hop 관계만 준다. 외부 AI가 노드마다 `get_object`를 반복하면 구조를 탈 수 있지만(정석 에이전트 방식), 한 방에 서브그래프를 주면 hop 낭비가 준다:

```python
@mcp.tool() get_subgraph(entity_id, relations?, depth=2)   # → GET /api/entities/{id}/subgraph
```

- 비관리자에겐 `active_only` 자동 적용(기존 라우트 로직 재사용).
- "구조를 스스로 타고 조사"를 진짜 강력하게 만드는 도구 → **추천.**

---

## 5. 설계 B — 서버 에이전트 한방 호출 (지능화 검색 위임)

외부 AI가 자연어 질문만 던지면, **서버 내부 LLM**이 A의 도구들로 다단계 조사해 인용·추론과정과 함께 완결 답변을 돌려준다.

### 5.1 백엔드

**변경 거의 없음** — `POST /api/ai/agent`가 이미 이 일을 한다.

### 5.2 MCP 신규 도구 1종 (~20줄)

```python
@mcp.tool()
async def ask_ontology(query: str, ctx, max_hops: int = 6) -> dict:
    """자연어 질문 → 서버가 온톨로지+보고서를 스스로 다단계 조사해 근거와 함께 답한다.
    반환: answer, citations(보고서), objects(근거 객체), trace(추론과정)."""
    return await _post(ctx, "/api/ai/agent", {"query": query, "max_hops": max_hops})
```

### 5.3 주의점

- **게이트: `rag_qa` 엔티틀먼트 필요**(기존). MCP는 PAT=특정 유저이므로, 그 유저에게 `rag_qa`가 없으면 403.
  → **MCP용 계정에 `rag_qa` grant 필요**(문서화 필수).
- **내부 LLM(B300 / 운영 Ollama :11435) 품질에 종속** + 다중 hop → 초 단위로 느림.
  MCP `httpx` 타임아웃을 넉넉히(예: 120s). 서버는 이미 `run_in_threadpool`이라 이벤트루프는 안 막힘.

---

## 6. A vs B 트레이드오프

| | A (프리미티브) | B (서버 에이전트) |
|---|---|---|
| 추론 주체 | 외부 Claude (강함) | 서버 내부 LLM |
| 제어 세밀도 | 높음(스텝 통제) | 낮음(블랙박스 위임) |
| round-trip | 많음(N hop = N MCP 콜) | 1콜 |
| 반환 | 원자료(external이 조립) | 완결 답변 + 인용 + trace |
| 게이트 | 불필요(인증-only) | `rag_qa` 필요 |
| 지연 | hop당 짧게 | 한번에 길게 |

**추천: 둘 다 노출.** A가 질문의 본질(자율 조사), B는 "그냥 답만 원할 때"의 위임 편의.

---

## 7. 노출 후 최종 MCP 조사 도구 면모

| 도구 | 신규? | 매핑 |
|---|---|---|
| `list_object_types` | ✅ A | `/api/ai/ontology/tool` |
| `search_objects` | ✅ A | `/api/ai/ontology/tool` |
| `get_object` | ✅ A | `/api/ai/ontology/tool` |
| `get_subgraph` | ✅ A(선택) | `/api/entities/{id}/subgraph` |
| `ask_ontology` | ✅ B | `/api/ai/agent` |
| `search_reports` | 기존 | `/api/reports/search/semantic` |
| `describe_metadata` | 기존 | (작성용 flat 축, 유지) |
| `get_report` | 기존 | `/api/reports/{id}` |

> `describe_metadata`(작성용, flat axes+values)와 `list_object_types`(분석용, 속성 key·op·관계 타입)는
> 목적이 달라 **둘 다 유지**한다. 작성 계약(entity_ids 채우기)을 깨지 않기 위해 오버로드하지 않는다.

---

## 8. 보안 / 권한 체크리스트

- [ ] A 도구 = 인증-only. 보고서 근거는 `hybrid_search` / `all_visible_report_ids` 가시성 교집합 → 권한 밖 유출 없음.
- [ ] 비관리자 서브그래프 `active_only` 유지(deprecated 기준정보 비노출).
- [ ] B = `rag_qa` 게이트 유지, **MCP 유저 계정에 grant** 필요.
- [ ] `run_tool` 화이트리스트로 create/update 계열 실행기 노출 차단.
- [ ] MCP `httpx` 타임아웃 상향(B 다중 hop 대비).

---

## 9. 구현 규모

- 백엔드: 신규 엔드포인트 1개(~15줄, 설계 A). 설계 B는 백엔드 변경 0.
- MCP: 도구 4~5개(~80줄).
- 나머지는 **전부 기존 로직 재사용** — 반나절 규모.

---

## 10. 구현 순서(제안)

1. **A-1** 백엔드 `POST /api/ai/ontology/tool` (+ 화이트리스트) — `agent_tools.run_tool` 위임.
2. **A-2** MCP `list_object_types` / `search_objects` / `get_object` (도크스트링에 `_SYSTEM` 규칙 이식).
3. **B** MCP `ask_ontology` → `/api/ai/agent` (+ 타임아웃 상향, `rag_qa` 문서화).
4. **A-3**(선택) MCP `get_subgraph` → `/api/entities/{id}/subgraph`.
5. `McpTab.jsx`(프론트 도구 안내)·MCP README 갱신.
