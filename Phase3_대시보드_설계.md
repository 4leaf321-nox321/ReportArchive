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
  // 부서 × 템플릿 crosstab 은 제거(아래 "제거: 부서×템플릿" 참조).
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

### 제거: 부서×템플릿 (crosstab) — **드롭 확정**
- 현재 대시보드의 "부서 × 템플릿" 스택드 바는 **제거**한다(사용자 결정, 2026-06-14).
- 이유: 가치 대비 복잡도가 큼 — 서버 이전 시 `mount_workspaces` + 부모 walk 로 "자기 +
  직속 자식(손자는 자식으로 롤업)" 을 SQL 로 재현해야 했던, 3A 에서 가장 까다로운 조각.
  제거하면 3A 가 단일 컷오버로 단순해진다.
- 작업: 3A 컷오버 때 `DashboardPage.jsx` 의 crosstab/Legend/StackedBarChart 및 관련
  `scopedSlugs`/`rollupSlug`/`crosstab` useMemo 를 함께 삭제. KPI 의 `distinctTemplates`
  는 crosstab.orderedTemplates 대신 별도 distinct 카운트로 대체(서버가 내려줌).

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
- "콘텐츠 지표" 카드: 지표별 타일(값 + 단위 + Δ + sparkline ← Q2 결정). 지표 0개면 카드 숨김.
- 드릴다운(이 지표가 가장 큰/작은 보고서로 이동)은 후속.

### 결정 사항 (기본값)
- **D6. TemplateMetric 별도 테이블**(schema 비침투, 버전 횡단, 가변).
- **D7. MVP=key_value 스칼라만**. table/chart 는 후속.
- **D8. 추출=Python(중간규모) → SQL JSONB(스케일)**. 인터페이스 동일.
- **D9. 지표 관리 UI = 시스템 관리자**(누가 지표를 정하나 — 부서 매니저 허용은 후속 결정).

---

## 진행 순서 (제안)
1. **3A ✅ (완료, v0.45.0)**: `GET /api/dashboard` 엔드포인트 — KPI(+prev Δ)·단계·추세·
   건강도·엔티티·작성자Top. 프런트 대시보드를 단일 useAsync 로 교체, 클라 집계 7종 제거,
   **부서×템플릿 crosstab 삭제**. 백엔드 `app/modules/dashboard/`(services/schemas/routes),
   프런트 `shared/api/dashboard.js`. MVP=Python 추출(실DB 스모크 200 확인). content_metrics=[].
2. **3B-1**: `TemplateMetric` 모델 + 마이그레이션 + 관리 API/최소 UI.
3. **3B-2**: 서버 추출·집계 → `content_metrics` 채움 + 대시보드 "콘텐츠 지표" 카드.
4. **후속**: table/chart 지표, SQL JSONB 전환, 캐시, 지표 드릴다운.

## 결정됨 (2026-06-14)
- **Q1 → A. 전역·관리자 정의.** TemplateMetric 은 `template_id` 단위(전역), 시스템 관리자
  (템플릿 소유자)가 편집. 그 템플릿 쓰는 모든 부서가 동일 지표를 본다. 부서별 표시 on/off 는
  후속(전역 정의 위에 비파괴로 얹음).
- **Q2 → sparkline 처음부터 포함.** 3B-2 에서 값 + Δ + 버킷별 추세(sparkline)를 함께 낸다.
  서버가 metric 별 `trend`(주/월 버킷, 같은 agg) 를 채우고 프런트는 미니 차트로 렌더.

---

## (참고) 결정 배경 — 구현 전 확인했던 질문

### Q1. 지표를 누가 지정하고, 적용 범위는?
숨은 핵심: **TemplateMetric 은 template_id(템플릿 패밀리) 에 매달린다 → 그 템플릿을 쓰는
모든 부서 대시보드에 동일하게 뜬다.** "누가 편집하나" 보다 "전역이냐 부서별이냐" 가 먼저.
- **권장(A) 전역·관리자 정의**: 시스템 관리자(=템플릿 소유자)가 템플릿당 표준 지표를 소수
  큐레이션. 모든 부서가 같은 지표를 본다. 가장 단순, 템플릿처럼 "권위 있는" 지표.
  위험: 부서마다 관심 숫자가 다르면 일부엔 노이즈(예: 같은 해석 템플릿 — 구조팀 최대응력 vs
  열팀 최대온도). → 후속에서 **부서별 on/off 선택** 레이어로 해소(2계층: 관리자 정의 +
  부서 표시선택). MVP 는 전역.
- (B) 부서 매니저도 정의: 템플릿이 공유 자산이라 부서가 건드리면 타 부서로 새거나,
  TemplateMetric 을 (template_id, workspace_slug) 로 키잉해야 함 → 모델·복잡도 증가. 후순위.
- 결정 필요: **MVP=A(전역·관리자)** 로 갈지.

### Q2. 추세 sparkline 을 지금 낼지, 값+Δ 만 먼저 낼지
- **값+Δ**: 현재 기간 agg + 직전 기간 agg 두 숫자. KPI Δ 로직 재사용, 희소 데이터에도 견고,
  저비용.
- **sparkline**: 버킷(주/월)마다 그 구간 보고서를 모아 같은 agg 적용 → N버킷 추출 + 미니
  차트 컴포넌트. 의미는 일관(버킷별 max/sum/avg 모두 성립)하나, 보고서 희소하면 비고
  많고 노이즈. 응답엔 이미 `trend` 필드 예약돼 있어 **나중에 채워도 비파괴**.
- **권장: 값+Δ 먼저(3B-2), sparkline 후속.** Δ 가 "오르나/내리나" 의 80%를 저비용·견고하게
  전달. 데이터 밀도 확인 후 폴리시로 추가.

### Q3. 3A 컷오버 영향 범위
- 대시보드 외 listReports 소비처(목록·홈)는 그대로 — 대시보드만 전용 API 로 교체.
  부서×템플릿 제거도 DashboardPage 안에서만 끝남(현재로선 외부 영향 없음). 착수 전 재확인.
