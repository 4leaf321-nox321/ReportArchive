# Phase 3 — 서버 집계 API · 콘텐츠 수치 인사이트 (설계)

부서홈_대시보드_설계.md 의 Phase 3. 두 갈래다. 서로 의존하므로 **3A 먼저, 그 위에 3B**.

- **3A 서버 집계 API** — 지금 클라이언트가 전 보고서를 받아 계산하는 대시보드 집계를
  서버로 옮긴다. 큰 조직 성능·콘텐츠 파싱의 토대.
- **3B 콘텐츠 수치 인사이트** — 템플릿이 "이 블록의 이 필드가 지표다" 라고 지정하면,
  서버가 그 숫자를 보고서마다 꺼내 기간·부서별로 집계한다.

---

## 현재 상태 (왜 옮기나)
- `DashboardPage.jsx` 가 `listReports()` 로 **부서의 모든 보고서**(요약 + entities + mount + pages)
  를 받아 클라이언트에서 KPI·단계·추세·부서×템플릿·건강도·엔티티·작성자Top 을 전부 계산.
- 한계: ① 보고서 수천 건이면 페이로드·계산 부담. ② 콘텐츠 수치 인사이트(3B)는
  본문(content)까지 받아 파싱해야 하는데, 본문은 요약에 없고 무겁다 → 클라이언트론 불가.
- 결론: 집계를 서버로. 응답 shape 는 **지금 컴포넌트가 쓰는 모양 그대로** 돌려줘 프런트 변경 최소화.

---

## 3A. 서버 집계 API

### 엔드포인트
```
GET /api/dashboard?from=<date>&to=<date>&unit=week|month
```
- 부서 컨텍스트는 기존대로 `X-Workspace-Slug` 헤더(권한 자동). `ws` 쿼리 안 씀 — 다른
  엔드포인트(listReports 등)와 일관.
- `from`/`to`: 보고 기준일 범위(생략 시 전체). `unit`: 추세 버킷 단위.
- 가상(_global)·외부 공개 열람자 처리는 기존 엔드포인트와 동일.

### 응답 (현 컴포넌트 props 에 맞춤)
```jsonc
{
  "kpis":   { "total": N, "authors": N, "templates": N,
              "prev": { "total": N, "authors": N, "templates": N } },  // Δ용 직전 기간
  "phase_breakdown": { "drafting": N, "reviewing": N, "finalized": N },
  "trend":  [ { "key": "2026-W20", "label": "W20", "count": N }, ... ],
  "crosstab": {                       // 부서 × 템플릿 (자기 + 직속 자식, 손자는 자식으로 롤업)
    "workspaces": [ { "slug", "name" } ],
    "templates":  [ { "template_id", "name", "count" } ],   // usage desc
    "counts": { "<ws_slug>": { "<template_id>": N } }
  },
  "health": { "stale_drafts": N, "uncategorized": N, "open_comments": N },  // 현재 상태 기준(기간 무관)
  "entity_coverage": { "top": [ { "id", "label", "count" } ], "no_entity": N, "distinct": N },
  "author_top":      { "top": [ { "label", "count" } ], "distinct": N, "unknown": N },
  "content_metrics": [ /* 3B — 3A 단계에선 빈 배열 */ ]
}
```

### 집계 방식 (대부분 SQL GROUP BY)
- 날짜 필터: **report_date 우선, 없으면 created_at**(현 `parseReportDate` 와 동일 규칙).
  SQL 에선 `COALESCE(report_date, created_at::date)` 로 정규화해 한 곳에서 비교.
- KPI total/단계/작성자: `GROUP BY` + `COUNT`/`COUNT(DISTINCT owner_user_id)`.
- 직전 기간(prev): 같은 길이의 바로 앞 구간을 한 번 더 집계(현 `prev` useMemo 로직).
- 추세: `date_trunc`('week'|'month') GROUP BY. 빈 버킷은 서버가 채워 연속 보장.
- 엔티티 커버리지·작성자Top: 링크/owner 로 GROUP BY + top N.
- 건강도: 기존 3개 — 정체 초안(`phase='drafting'` AND `updated_at < now-14d`), 미분류
  (mount.folder_id IS NULL 또는 personal folder_id IS NULL), 미해결 코멘트(이미 만든
  `count_open_threads_for_reports`).

### 가장 까다로운 부분 — 부서×템플릿 crosstab
- 현재 클라가 `mount_workspaces` + 부모 walk 로 "자기 + 직속 자식(손자는 자식으로 롤업)"
  을 만든다. 서버에선:
  1. scope = 자기 + 직속 자식 슬러그.
  2. `ReportMount` 조인, mount.workspace_slug 를 scope 로 롤업(자손→직속 자식). 부모 체인은
     `ws_services.get_descendants_inclusive` 역방향 — 직속 자식별 자손 집합을 미리 만들어 매핑.
  3. 보고서의 distinct 템플릿 × distinct 버킷으로 카운트(현 로직과 동일하게 보고서당 1).
- 멀티페이지: 한 보고서가 여러 template_id 를 쓸 수 있음 → `uniqueTemplateIds` 와 동일하게
  pages 의 template_id distinct.

### 결정 사항 (기본값)
- **D1. 헤더 스코프 유지**(쿼리 ws 안 씀). 기존 권한 경로 재사용.
- **D2. 응답 shape = 현 컴포넌트 props**. 프런트는 useAsync 한 번으로 교체, 7개 useMemo 제거.
- **D3. 컷오버 방식**: 신 엔드포인트로 한 번에 전환하고 클라 집계 코드 삭제(분기 드리프트 방지).
  단, **listReports 기반 화면(목록·홈)은 그대로** — 대시보드만 전용 API.
- **D4. 캐시 없음(MVP)**. 요청마다 계산. 느려지면 부서+기간 키로 단기 캐시 추가.
- **D5. SQL 우선**: 카운트/그룹바이는 전부 SQL. content(3B)만 별도 취급.

---

## 3B. 콘텐츠 수치 인사이트

### 지표를 어디에 정의하나 — **별도 엔티티 `TemplateMetric`** (템플릿 schema 안에 넣지 않음)
이유: 템플릿은 `(template_id, version)` 불변이라 schema 에 박으면 지표를 바꿀 때마다 새 버전이
필요. 지표 지정은 대시보드 운영 관심사라 **가변·관리자 편집**이어야 함. → 템플릿 *패밀리*
(`template_id`) 에 매다는 작은 별도 테이블이 깔끔하고 버전 횡단으로 적용된다.

```
TemplateMetric
  id
  template_id      # 어느 템플릿 패밀리
  block_id         # 그 위젯 블록 (schema 의 안정 slug)
  field_key        # key_value 의 item key (스칼라). null 가능(블록 값 자체)
  source_kind      # 'key_value' (MVP). 후속: 'table_column' | 'chart_series'
  agg              # sum | avg | min | max | count | last
  label            # 표시명 (예: "최대 응력")
  unit             # 선택 (예: "MPa", "%")
  enabled
  display_order
```
- 관리: 시스템 관리자 화면(계정관리 옆) 또는 템플릿 상세에 "대시보드 지표" 탭. 블록·필드는
  해당 템플릿 schema 에서 key_value 블록 + 그 items 를 읽어 드롭다운 제공(오타 방지).

### MVP 범위 — **key_value 스칼라만**
- 보고서 1건 → 지표 1개당 숫자 1개. 추출: `content[block_id][field_key]` (없으면 pages 순회 첫 매치).
  block_id 는 템플릿 내 unique 라 페이지 모호성 적음. 멀티페이지 동일템플릿 반복은 후속 과제.
- `table_column`/`chart_series`(rows 안 다수 숫자)는 "보고서 내 집계 후 보고서 간 집계" 2단계라
  복잡 → **후속**. MVP 에서 source_kind 는 key_value 만.

### 추출·집계 (서버, 3A 응답의 content_metrics 에 합류)
- 대상: 기간·부서 스코프 보고서 중 그 template_id 를 쓴 것.
- 각 보고서에서 숫자 1개 추출 → 결측/비숫자는 제외(분모에서 빼고 `n` 로 보고).
- agg 적용 + 직전 기간 Δ + (선택) 버킷별 추세(sparkline).
```jsonc
"content_metrics": [
  { "id", "label": "최대 응력", "unit": "MPa", "agg": "max",
    "value": 412.5, "n": 7, "prev": 388.0,
    "trend": [ { "key": "2026-W19", "value": 401 }, ... ] }   // 선택
]
```

### 성능 메모 — content 읽기
- content/pages 는 무겁다. 두 갈래:
  - **(MVP) Python 추출**: 기간·부서 보고서의 `id, content, pages, report_date, owner` 만
    로드해 파싱. 데이터 중간 규모까진 충분. 단순·정확.
  - **(스케일) SQL JSONB**: `(content #>> '{block_id,field_key}')::numeric` 로 DB 가 추출 →
    행을 안 끌어옴. pages 경로는 함수/뷰 필요. 느려지면 전환.
- 결정: **MVP=Python 추출**, 한계 보이면 SQL JSONB 로(인터페이스 동일하게).

### 대시보드 표시
- "콘텐츠 지표" 카드: 지표별 타일(값 + 단위 + Δ, 있으면 sparkline). 지표 0개면 카드 숨김.
- 드릴다운(이 지표가 가장 큰/작은 보고서로 이동)은 후속.

### 결정 사항 (기본값)
- **D6. TemplateMetric 별도 테이블**(schema 비침투, 버전 횡단, 가변).
- **D7. MVP=key_value 스칼라만**. table/chart 는 후속.
- **D8. 추출=Python(중간규모) → SQL JSONB(스케일)**. 인터페이스 동일.
- **D9. 지표 관리 UI = 시스템 관리자**(누가 지표를 정하나 — 부서 매니저 허용은 후속 결정).

---

## 진행 순서 (제안)
1. **3A-1**: `/api/dashboard` 엔드포인트 — KPI·단계·추세·건강도·엔티티·작성자Top(crosstab 제외)
   먼저. 프런트 대시보드를 이 응답으로 교체(crosstab 만 잠시 클라 유지).
2. **3A-2**: crosstab 서버 이전(롤업 SQL) → 클라 집계 완전 제거.
3. **3B-1**: `TemplateMetric` 모델 + 마이그레이션 + 관리 API/최소 UI.
4. **3B-2**: 서버 추출·집계 → `content_metrics` 채움 + 대시보드 "콘텐츠 지표" 카드.
5. **후속**: table/chart 지표, SQL JSONB 전환, 캐시, 지표 드릴다운.

## 미해결 질문 (구현 전 확인)
- Q1. 지표를 **누가** 지정하나? 시스템 관리자만(D9) vs 부서 매니저도.
- Q2. 추세 sparkline 을 3B-2 에 포함할지, 값+Δ 만 먼저 낼지.
- Q3. 3A 컷오버 시 대시보드 외 다른 listReports 소비처에 영향 없는지 재확인(현재로선 없음).
