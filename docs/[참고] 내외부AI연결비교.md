# 내부 AI vs 외부 AI — 연결·도구 비교

> 작성 2026-07-17 · 기준 **v0.136.0** · 코드 실측(문서 주장 아님).
>
> **내부 AI** = 앱 안의 로컬 LLM 에이전트(`POST /api/ai/agent` → `app/ai/agent.py::run_agent`).
> 웹 검색화면의 "에이전트" 모드·대화형(/chat)이 이걸 쓴다.
> **외부 AI** = MCP 클라이언트(Claude Desktop 등)가 `mcp_server/server.py` 를 통해 붙는 것.
>
> 관련: `[완료] MCP온톨로지조사_설계.md`, `[완료] 온톨로지 에이전트_tool-calling_설계.md`,
> `[완료] MCP보고서작성_설계.md`, `[일부] system객체확장_user·report투영_설계.md`.

---

## 0. 한 줄 요약

**외부 AI가 내부 로컬 LLM보다 할 수 있는 게 훨씬 많다.** 내부는 **읽기 전용 도구 6개**뿐이고,
외부는 **20개**에 **보고서를 직접 만들고 고칠 수 있다**. 직관과 반대다.

이유는 역사다 — MCP 는 원래 **"외부 AI가 보고서를 대신 써주는"** 플랫폼으로 만들어졌고
(`[완료] MCP보고서작성_설계.md`), 온톨로지 조사는 나중에 얹혔다(v0.76). 내부 에이전트는
처음부터 **질문에 답하는 것만** 하도록 설계됐다(v0.74).

---

## 1. 도구 카탈로그

### 1.1 내부 AI — 6개 (`app/ai/agent_tools.py::_CATALOG` → `TOOL_SCHEMAS`)

| 도구 | 파라미터 | 필수 |
|---|---|---|
| `list_object_types` | — | — |
| `search_objects` | `type` `q` `props` `relations` `year` `limit` | — |
| `get_object` | `type` `id` | `type`, `id` |
| `get_subgraph` | `entity_id` `relations` `depth` | `entity_id` |
| `search_reports` | `query` `author` `report_type` `phase` `lifecycle` `date_from` `date_to` `last_days` `period` `limit` | `query` |
| `aggregate_reports` | `filters` `target` `year` + 위 필터 8종 | `filters` |

**전부 읽기 전용.** 쓰기 도구는 하나도 없다.

### 1.2 외부 AI — 20개 (`mcp_server/server.py` 의 `@mcp.tool()`)

| 분류 | 도구 | 도착 경로 |
|---|---|---|
| **온톨로지 조사** | `list_object_types` · `search_objects` · `get_object` · `aggregate_reports` | `POST /api/ai/ontology/tool` |
| | `get_subgraph` | `GET /api/entities/{id}/graph` |
| | `ask_ontology` | `POST /api/ai/agent` (내부 에이전트에 **위임**) |
| **검색·조회** | `search_reports` | `GET /api/reports/search/semantic` (**자체 도구**) |
| | `get_report` · `list_my_drafts` | `/api/reports/*` |
| **작성 (쓰기)** | `create_report_draft` · `update_report_draft` | `/api/reports/ai-draft` |
| **파일** | `upload_file` · `upload_from_url` · `download_file` · `prepare_upload` · `extract_pptx_images` | `/api/files/*` |
| **작성 가이드** | `list_templates` · `describe_template` · `describe_widgets` · `describe_metadata` | `/api/templates`·`/api/widgets`·`/api/report-types`·`/api/entity-types` |

---

## 2. 온톨로지 조사 — 이제 거의 같다

| 도구 | 내부 | 외부 | 비고 |
|---|:--:|:--:|---|
| `list_object_types` | ✅ | ✅ | |
| `search_objects` | ✅ | ✅ | |
| `get_object` | ✅ | ✅ | |
| `aggregate_reports` | ✅ | ✅ | **2026-07-17 화이트리스트 추가** |
| `search_reports` | ✅ 필터 10개 | ✅ 필터 10개 | **2026-07-18 통일**(§2.1). MCP 자체 도구를 내부판 위임으로 교체 |
| `get_subgraph` | ✅ | ✅ | **2026-07-18 내부에도 추가**(§2.2). 내부 전용이라 화이트리스트엔 없음 |
| `ask_ontology` | — (자기 자신) | ✅ | 외부→내부 위임 |

### 2.1 ✅ 비대칭 A — `search_reports` 통일(2026-07-18, 해소)

원래 MCP 자체 도구는 `q`·`limit` 만 받아, 라우트(`/search/semantic`)가 받는 필터를 **버렸다**:

- **필터 자체를 못 걸었다** — 라우트는 `date/type/author/phase` 를 받는데 MCP 도구가 안 넘겼다.
  *"지난달 주간보고 중 낙하시험 관련"* 을 표현할 방법이 없었다.
- **이름→id 해석이 없었다** — 라우트는 `report_type_ids`·`author_ids`(정수)를 받는다. 외부 AI 는
  "박세현"·"주간보고" 라는 이름만 알아 먼저 id 를 찾아야 했다. 내부판은 `_column_filters_from_args`
  가 이름을 그대로 풀어준다(실측: `_resolve_author("박세현") → 4`).
- **근거 텍스트가 얇았다** — 내부판은 `block_id`·`page_idx`·`snippet` 까지 실어 근거 검증에 쓴다.

**해소**: 화이트리스트에 `search_reports` 추가 + MCP 자체 도구를 **내부판 위임**으로 교체
(`_get(...)` → `_ontology_tool(ctx, "search_reports", ...)`). 라우트도 이름 해석도 손대지 않았다 —
둘 다 `agent_tools` 판에 이미 있어서다. 게이트 두 기준 충족: `hybrid_search` 는 `embed_one`(임베딩)
만 쓰고 생성 `chat()` 은 안 부르며, `_visible_scope_ids` 로 가시성 게이팅.

실측 — 필터가 SQL 에 실제로 걸린다: `query="보고"` 8건 → `+phase=finalized` 1건 / `+phase=drafting`
5건. 유출 재확인: 비가시 25건 × 2명 = 0건.

### 2.2 ✅ 비대칭 B — `get_subgraph` 를 내부에도 추가(2026-07-18, 해소)

관계를 여러 홉 타는 걸 한 콜로 끝내는 도구인데 원래 **외부에만 있었다.** 내부는 `get_object`
를 반복해 홉을 타야 했고, 그만큼 **홉 예산(`_MAX_TOOL_CALLS_PER_HOP=6` / `_TOTAL=20`)을 빨리
썼다**. → `agent_tools._exec_get_subgraph` 추가로 해소.

구현 노트:
- **라우트와 조립 공유** — `_augment_graph_object_links`(+`visible_report_ids_for`)를
  `routes.py` 에서 `services.py` 로 옮겨, 라우트(entity_subgraph)와 도구가 **같은** 그래프
  조립(구조 CTE + object_links augment)을 쓴다. 실측: 같은 seed 로 노드 수 일치.
- **seed 는 엔티티만** — report/user/dept 는 그래프 노드가 아니라 get_object 로 조사.
  없는 id 는 안내 에러.
- **크기 상한** — `graph.subgraph` 는 depth 로만 제한해 고차수 노드면 폭주 → depth 1~2 클램프
  + 노드 40개 상한, 초과 시 `truncated` 신호(에이전트에 relations 로 좁히라고 안내).
- **가시성** — augment 가 `actor.user` 로 report 노드를 게이팅(비가시 보고서는 그래프에서 드롭).

`[완료] 온톨로지 에이전트_tool-calling_설계.md` §10 의 `get_linked_objects` 후속 항목을 이걸로
대체(전용 도구 대신 subgraph 로 통합).

---

## 3. 외부에만 있는 것 — 보고서 작성 13개

내부 에이전트엔 **전혀 없는** 영역이다.

- **쓰기**: `create_report_draft` · `update_report_draft`
- **파일**: `upload_file` · `upload_from_url` · `download_file` · `prepare_upload` ·
  `extract_pptx_images`
- **작성 가이드**: `list_templates` · `describe_template` · `describe_widgets` ·
  `describe_metadata`
- **조회**: `get_report` · `list_my_drafts`

---

## 4. ★ 권한 게이트가 서로 다르다

| 경로 | 게이트 | 근거 위치 |
|---|---|---|
| 내부 `POST /api/ai/agent` | **`rag_qa` 엔티틀먼트** 없으면 403 | `ai/routes.py` `ai_enabled_for(db, actor.user, "rag_qa")` |
| 외부 `POST /api/ai/ontology/tool` (도구 4종) | **인증만** — 엔티틀먼트 불필요 | `ai/routes.py::ontology_tool` |
| 외부 `ask_ontology` → `/api/ai/agent` | **`rag_qa` 필요** | 위와 동일 |
| 외부 `create_report_draft` → `/api/reports/ai-draft` | **인증만** (개인 공간 생성이라 보드 쓰기 권한 무관) | `reports/routes.py::create_ai_draft` |
| 외부 `get_subgraph` → `/api/entities/{id}/graph` | **인증만** (`entity_actor`) | `entities/routes.py::entity_subgraph` |

⇒ **같은 사람이 웹에서 "에이전트" 모드를 쓰려면 `rag_qa` 권한이 필요한데, MCP 토큰만 있으면
권한 없이 온톨로지를 뒤지고 보고서까지 만들 수 있다.**

**이건 구멍이 아니다 — 명시된 설계다.** 온톨로지 도구는 ① **생성 LLM 을 안 부르고**(비용 0)
② 보고서는 **가시성 게이팅**된다(유출 0). `rag_qa` 는 "AI 답변 생성"을 재는 게이트이지
"데이터 열람" 게이트가 아니다. 화이트리스트에 도구를 추가할 때 반드시 이 **두 조건**을
확인해야 한다(2026-07-17 `aggregate_reports` 추가 시 확인한 방식):

- 생성 LLM 미호출? — `structured_qa` 의 `chat()` 은 `_extract`(=`maybe_answer` 전용)에만 있고
  `aggregate` 경로엔 없다.
- 가시성 게이팅? — `_base_reports` 가 `all_visible_report_ids(actor.user.id)` 로 교집합.

> **확인 권장**: 의도한 설계인지 리뷰할 가치는 있다. MCP 계정은 결국 특정 사용자의 PAT 이고,
> 그 사람은 웹에서 못 하는 걸 MCP 로는 할 수 있다.

---

## 5. 공통점 — 같은 실행기를 쓴다

내부·외부 **둘 다 같은 `agent_tools` 실행기**를 탄다(외부는 `/api/ai/ontology/tool` 이
`agent_tools.run_tool` 을 그대로 호출). 그래서:

- 2026-07-17 수정분(actor 배선 · `led_by` 관계 필터 · `props` 가드 · report 속성/관계 투영)이
  **양쪽에 동시에 적용**됐다.
- 가시성도 도구 내부에서 동일하게 걸린다. 실측 — `aggregate_reports` 가
  **user2 → 71건 / user3 → 72건** (전체 1694건 아님).

**따라서 도구 동작을 고칠 땐 `agent_tools` 한 곳만 고치면 되고, 반대로 거기가 깨지면 내부·외부가
같이 깨진다.**

---

## 6. 정리 · 메울 만한 공백

| 축 | 우세 |
|---|---|
| 온톨로지 조사 | **동등** — `get_subgraph`·`search_reports` 격차 해소(2026-07-18) |
| 보고서 작성 | **외부** 압승 (내부는 아예 없음) |
| 권한 | **외부**가 느슨 (엔티틀먼트 없이 조사 가능) |

**공백 — 둘 다 해소됨(2026-07-18):**

1. ~~내부에 `get_subgraph` 추가~~ → **완료(§2.2).**
2. ~~외부 `search_reports` 를 내부판으로 통일~~ → **완료(§2.1).** MCP 자체 도구를 화이트리스트판
   위임으로 교체 — 외부도 이제 날짜·종류·작성자 필터 + 이름 해석을 쓴다.

⇒ **온톨로지 조사 도구는 내부·외부가 동등해졌다.** 남은 비대칭은 **권한**(외부가 엔티틀먼트
없이 조사·작성 가능, §4)뿐이며, 이는 구멍이 아니라 명시된 설계다(리뷰 여지는 있음).

**비목표**: 내부 에이전트에 쓰기 도구를 주는 것은 **Phase E(`apply_action`, write-back)** 의
영역이며 현재 코드 0줄이다 — `[참고] 팔란티어 벤치마킹.md` §4-2.
