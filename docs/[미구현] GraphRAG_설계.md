# GraphRAG — 연결된 그래프 전체를 근거로 답하기 (팔란티어 벤치마킹 2c)

> B300 RAG Q&A가 단일 문서(청크) 유사도만 보던 것을, **온톨로지 그래프**로
> 확장한다. 질문이 다루는 객체를 찾아 → 연결된 이웃 객체까지 넓히고 → 그
> 이웃에 연결된 보고서의 근거를 우선해 답한다. 모든 답에 **출처(보고서·작성자·
> 날짜)** 를 단다. 상세 배경: `[참고] 팔란티어 벤치마킹.md` 가로축(2c).

## 0. 왜 지금 되는가 — 배관은 이미 깔려 있다

기존 조각(조사 확인):
- `app/ai/search.py :: hybrid_search(..., entity_ids=, entity_rollup=)` — 검색을
  **특정 객체 집합에 연결된 보고서**로 좁히는 인자가 이미 있음.
- `app/modules/entities/services.py :: expand_related(db, entity_ids=)` — 씨앗
  객체 → 연결 이웃(이행관계 자손 롤업 + 비이행 1-hop) 확장 정책.
- `entity_filter_report_ids` — 객체 집합 → 보고서 id.
- 가시성(grant) 가드가 `hybrid_search` 안에 이미 적용 → 그래프로 넓혀도 권한
  밖 보고서는 근거로 새지 않음.
- `report_entities` — 보고서 ↔ 객체 링크(양방향 조회 함수 존재).

**없던 것(이번 구현):** ① 질문 → 씨앗 객체 링킹, ② QA 오케스트레이션(그래프
근거 블렌드), ③ 출처 강화(작성자·날짜·객체 경로).

신규 테이블·마이그레이션 0, Apache AGE 0, 저장형 임베딩 0 (온플라이 재사용).

## 1. 결정 사항 (확정)

1. **객체 링킹 = 키워드 + 임베딩 혼합.** 질문 텍스트에 객체 이름이 들어있으면
   부분일치(강한 신호) + 임베딩 코사인 보강. LLM 추가 호출 없음(autotag 방식
   재사용). mock 임베딩 백엔드(개발 기본)에선 키워드만 동작 → 테스트 가능.
2. **블렌드.** 그래프 확장 근거를 가중치로 끌어올리되, 순수 벡터검색 결과도
   유지. 링킹이 빗나가도 근거를 잃지 않음.
3. **기존 `/api/ai/ask`에 토글.** `graph: bool` 인자 추가 + 프론트 Q&A에
   "그래프 근거" 토글. 새 엔드포인트/화면 없음.

## 2. 흐름

```
질문
 ├─ ① link_query_entities(q)         → 씨앗 객체 [E…]        (키워드+임베딩)
 │      seeds 없으면 graph 근거 생략, 순수 벡터로 폴백
 ├─ ② expand_related(seeds)          → 연결 이웃 집합 [E…+neighbors]
 ├─ ③ 두 갈래 검색
 │      graph_hits = hybrid_search(q, entity_ids=이웃)   (그래프 근거)
 │      plain_hits = hybrid_search(q)                     (일반 벡터)
 │      blend: 그래프 히트에 ×BOOST → report_id로 병합·재정렬·상위 N
 └─ ④ 출처 강화 프롬프트 → LLM
        citation += {author, date, graph:bool, objects:[연결 객체값…]}
        top-level += {seeds:[{id,value,type}…], graph:true}
```

## 3. 백엔드

### 3.1 `app/ai/graph_link.py` (신규)
`link_query_entities(db, query, *, limit=6) -> list[dict]`
- 키워드 후보: `Entity.value ILIKE %토큰%` (status=active), 상한 `_MAX_CANDIDATES=300`.
- 강한 신호: `value.lower() in query.lower()` → score 1.0.
- 임베딩 보강(백엔드≠mock): 질문 임베딩 ↔ 후보 값 임베딩 코사인, `min_score`
  이상만. autotag `_similarity` 와 동일 패턴(지연 import).
- 상위 `limit`개 반환: `{id, value, type_slug, type_label, via:'keyword'|'embedding'}`.

### 3.2 `app/ai/qa.py` (확장)
- `_retrieve(db, actor, query, *, limit, graph=False)` — graph=True면 위 ①②③④.
  - 블렌드: `_GRAPH_BOOST=1.5`. `report_id`별 max(plain, graph×boost), graph 히트는
    `graph=True` 마킹. 정렬 후 상위 `limit`.
  - 출처 강화: 인용 보고서들의 `owner.name`(작성자)·`updated_at`(날짜)를 한 번에
    조회(1 JOIN). 그래프 히트엔 그 보고서가 링크한 이웃 객체값(`report_entities ∩
    이웃`) 몇 개를 `objects`로.
  - 반환 튜플에 `seeds` 추가 → `_finalize`가 응답에 실어보냄.
- `ask_archive` / `ask_archive_cancellable` 에 `graph=False` 인자 관통.
- `_finalize(..., seeds=None, graph=False)` → 응답에 `seeds`, `graph` 필드 추가.

### 3.3 `app/modules/ai/routes.py`
- `AskPayload.graph: bool = False` 추가, 오케스트레이터에 전달.

## 4. 프론트

Q&A 화면(예: `AiAskPanel`)에:
- **"그래프 근거" 토글** → `ask({query, limit, graph})`.
- 답변 위에 **"이 질문이 다룬 객체"** 칩(seeds, 클릭 시 객체 프로필).
- 출처 카드에 **작성자·날짜** 배지, 그래프 근거엔 **연결 객체** 태그 + "그래프"
  배지로 구분.

## 5. MVP 범위 vs 후속

- **MVP:** 위 3·4 전부. 신규 테이블 없음.
- **후속:** ⓐ 저장형 엔티티 임베딩(값 임베딩 캐시 → 링킹 성능), ⓑ 스팬 단위
  청크↔객체 링크(현재 보고서 단위만), ⓒ Apache AGE 백엔드(D-3), ⓓ 링킹/답변
  품질 평가 하니스, ⓔ `Entity.value` 트라이그램 인덱스(ILIKE 후보 스캔 가속).

## 6. 검증

- 백엔드 `tests/test_graphrag.py`: 축+엔티티+관계+보고서 링크를 만들고,
  질문→씨앗 링킹(키워드), expand_related 이웃 확장, 그래프 히트가 블렌드에서
  상위로 오는지, 출처에 작성자·날짜·objects가 붙는지. mock 임베딩 기준.
- eslint + esbuild(프론트), pytest(백).
