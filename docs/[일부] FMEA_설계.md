# FMEA 기능 — 본격 구현 설계

CAE·신뢰성 도메인의 핵심 산출물인 **FMEA(Failure Mode and Effects Analysis,
고장형태 영향분석)** 를 단순 "표 한 장"이 아니라, **구조화 위젯 + 자동 RPN 평가 +
위험 시각화 + 과거 사례 AI 추천 + 조직 차원의 FMEA 지식베이스/액션 추적**까지
아우르는 1급 기능으로 구현하기 위한 계획.

> 배경: `부족한부분.md` §4-5 에서 FMEA 연관문서 추천을 "도메인 킬러"로 지목.
> 토대(임베딩·시맨틱 검색)는 `AI_RAG_현황.md` 에 이미 구축됨 — 본 문서는 그 위에
> FMEA 도메인 기능을 올린다. 위젯 시스템은 `app/widgets/registry.py` 컨벤션을 따른다.
>
> **상태: P0~P2 구현 완료(2026-07-18). P3~P5 후속.** 온톨로지 통합형으로 구현 —
> 고장모드를 자유 텍스트가 아니라 **불량모드(failure_mode) record 엔티티**로 승격해,
> `get_object`/`search_objects`/파생 `documents` 링크가 그대로 꽂힌다(같은 불량모드가
> 나온 모든 보고서 조회·AI 조사·유사사례 추천). 구현물:
> - **P0** 마이그 `p88_failure_mode_axis` — failure_mode record 축(open·derived)+category 속성.
> - **P1** 위젯 등록(`registry.py` `_fmea_content`+`FMEA`, ref category `fmea`) · 위젯 컴포넌트
>   (`Fmea.jsx` — RPN=S×O×D 파생·rt-c 위험색상·RecordNamePicker 고장모드 셀·호버 설명 헤더) ·
>   엔티티 승격(`_materialize_record_widgets` FMEA 분기 — rows[].failure_mode→upsert+태깅) ·
>   내보내기(DOCX visual-capture, PPTX native table).
> - **P2** 유사사례 추천 — `/related?text=`(임의 텍스트 semantic_search) + FmeaEditor "유사 과거사례"
>   패널(`semanticSearchReports`, 행별 ✨). 점수(S·O·D·RPN)는 엔티티 속성 아닌 위젯 JSON.
> - 검증: 승격 E2E(test_record_widget)·`?text=`(test_report_search). 회귀 64건.
> - **잔여**: 관계 타입(occurs_in 등)·P3 대시보드(RPN 횡단, fmea_items 투영)·P4 액션추적·P5 생성LLM.

---

## 0. 한눈에 보기

| Phase | 내용 | LLM 필요 | 공수(러프) | 상태 |
|---|---|---|---|---|
| **P0. 불량모드 엔티티 축** | failure_mode record 축 시드(고장모드를 온톨로지로) | ❌ | 마이그 1장 | ✅ **완료**(p88) |
| **P1. FMEA 위젯 + 승격** | 구조화 표(S·O·D→RPN 자동·색상), 고장모드 엔티티 승격, 내보내기 | ❌ | 1.5~2주 | ✅ **완료** |
| **P2. 과거 사례 AI 추천** | 작성 중 유사 FMEA/보고서 자동 추천(벡터) | ❌ | 3~5일 | ✅ **완료** |
| **P3. FMEA 지식베이스** | RPN 대시보드/필터, 횡단 검색(RPN>100 전수 등) | ❌ | 2~3주 | ⬜ 후속(P1) |
| **P4. 액션 추적** | 권고조치 owner·기한·상태, 재평가(RPN before/after), 알림 | ❌ | 1.5~2주 | ⬜ 후속(P3+알림) |
| **P5. LLM 보조** | 고장모드/원인/대책 제안, 유사사례 기반 초안 자동생성 | ✅(B300) | 2주+ | ⬜ 후속(RAG P3) |

> **온톨로지 통합 결정(구현 시)**: 원안은 고장모드를 위젯 JSON 텍스트로 뒀으나, 구현은
> **불량모드 record 엔티티로 승격**(P0 신설). 그 결과 P3의 "행→쿼리가능 엔티티" 상당 부분이
> 이미 온톨로지로 달성됨 — get_object(failure_mode).documents 로 횡단 조회가 되고, 남은 P3는
> **RPN 등 점수 집계**(위젯 JSON 에 있어 fmea_items 투영 테이블 필요)에 집중된다.

원칙: **P1+P2 가 단독으로 즉시 가치(작성 편의 + 지식 재활용)를 낸다.** P3 이후는
"표를 넘어 데이터로" 가는 확장이며, P5 는 생성 LLM(B300) 연결 후.

---

## 1. FMEA 도메인 개요

FMEA 1행 = 하나의 잠재 고장에 대한 분석 단위:

```
항목/기능 → 고장모드(Failure Mode) → 영향(Effect)   → 심각도 S(1~10)
                                  → 원인(Cause)    → 발생도 O(1~10)
                                  → 현 관리(Control)→ 검출도 D(1~10)
                                  → RPN = S × O × D (1~1000)
                                  → 권고조치 → 담당/기한 → 재평가 RPN'
```

- **RPN(Risk Priority Number)** = S×O×D. 높을수록 우선 대응. 보통 **RPN > 100** 또는
  **S ≥ 9(안전)** 를 중점관리 임계로 삼는다.
- (선택) **AIAG-VDA AP(Action Priority, High/Medium/Low)** 방식도 있음 — RPN 곱 대신
  S·O·D 조합 테이블로 우선순위 결정. 본 설계는 **classic RPN 기본 + AP 컬럼 옵션**으로
  간다(§7 결정사항).
- 가치의 핵심은 **과거 FMEA 자산의 재활용** — 같은 고장모드를 매번 새로 쓰지 않게.

---

## 2. "본격적" 의 범위 정의

단순형(검색을 작성화면에 노출)과의 차이를 명확히:

| 차원 | 단순형 | 본격형(본 설계) |
|---|---|---|
| 입력 | 일반 표 위젯 | **FMEA 전용 위젯**(S·O·D 정수칸·RPN 자동·임계 색상) |
| 평가 | 수기 | **RPN 자동계산 + 위험등급 시각화 + 정렬/필터** |
| AI | 없음 | **작성 중 과거 유사사례 추천**(P2), 후엔 제안 생성(P5) |
| 데이터 | 보고서 JSON에 갇힘 | **엔티티 승격 → 조직 RPN 대시보드·횡단 검색**(P3) |
| 후속관리 | 없음 | **권고조치 추적·재평가·알림**(P4) |

---

## 3. 아키텍처 핵심 결정 — 위젯 JSON vs 전용 엔티티

현 코드베이스는 **구조화 데이터(RACI·표·비교 행)를 모두 위젯 JSON에 보관**하고, 전역
교차 엔티티(모델/부품 등 `app/modules/entities/`)만 별도 테이블을 둔다. 이 관성을 존중해
**단계적 승격** 전략을 택한다:

- **P1~P2**: FMEA 행은 **보고서 `content`/`pages[].content` 의 위젯 JSON**에 저장
  (다른 위젯과 동일). 검색/임베딩은 기존 `text_extraction` 가 자동 처리.
- **P3**: "RPN>100 전부 보기", "특정 고장모드 횡단 조회" 같은 **조직 차원 쿼리**가
  필요해지는 시점에 **`fmea_items` 읽기전용 투영 테이블**을 추가하고, 보고서 저장 훅에서
  동기화. **JSON이 원본(source of truth), 테이블은 파생 인덱스**로 둔다(검색 search_text
  재색인·임베딩 훅과 같은 after_commit chokepoint 재사용).

> 왜 처음부터 테이블이 아닌가: 위젯 JSON이 유연(스키마 진화·템플릿 무관)하고, 권한·버전·
> 휴지통·내보내기 등 보고서 인프라를 공짜로 얻기 때문. 테이블은 "데이터로서의 FMEA"가
> 실제로 필요해질 때 파생물로 붙이는 게 정합적.

---

## 4. 단계별 계획

### Phase 1 — FMEA 위젯 + 템플릿 (LLM 불필요)

**목표**: 작성자가 FMEA를 구조화 입력하고 RPN이 자동 계산·색상화되는 1급 위젯.

**백엔드** (`app/widgets/registry.py`)
- `_fmea_content(props)` 콘텐츠 스키마 정의: `rows[]` 각 행에
  `failure_mode, potential_effect, potential_cause, severity(1~10), occurrence(1~10),
  detection(1~10), rpn(파생), current_controls, recommended_action, responsible,
  due_date, status(open|in_progress|closed), target_rpn` + 기존 공통 필드
  (`caption`, `cell_styles`, `cell_html` 등 RACI/표 위젯과 동일 패턴 재사용).
- `FMEA: WidgetDescriptor` 추가 → **`WIDGET_REGISTRY` 튜플에 등록**.
- **`REF_CATEGORIES` + `REF_CATEGORY_BY_TYPE` 에 반드시 추가**
  (`"fmea": "fmea"`, 라벨 "FMEA"). 누락 시 import-time assert 로 모듈 로드 실패
  (registry의 안전장치). 본문에서 `#FMEA1` 교차참조 가능해짐.
- 검증(`app/widgets/validation.py`)은 `WIDGET_REGISTRY` 위에서 **자동** — 수정 불필요.

**임베딩/검색** (`app/widgets/text_extraction.py`)
- `_collect()` 가 JSON을 재귀 순회하므로 고장모드·영향·대책 **텍스트는 자동 색인**됨.
- **결정**: 점수(`severity/occurrence/detection/rpn`)를 검색 텍스트에 넣을지.
  숫자가 검색 노이즈가 되면 `_SKIP_KEYS` 에 추가(텍스트만 색인). → §7.

**프론트엔드** (`frontend/src/modules/templates/widgets/`)
- 신규 `FmeaAnalysis.jsx` — 위젯 3종 컴포넌트(기존 모든 위젯 공통 패턴):
  - `FmeaPropsPanel` — 템플릿 설계자용(라벨·행 제한·평가척도 프리셋·AP 사용여부).
  - `FmeaPreview` — 템플릿 편집 캔버스 스텁.
  - `FmeaEditor` — 작성자용. **S·O·D 변경 시 `rpn = s*o*d` 클라이언트 자동 재계산**
    (RACI의 파생 computeGroupRuns 와 동일한 "편집→재계산→onContentChange" 패턴),
    RPN 임계별 행/셀 색상(중점관리 강조), 컬럼 정렬·행 추가/삭제/재정렬,
    `readOnly` 지원, `_shared.jsx` 헬퍼(캡션·셀선택·그리드 내비) 재사용.
  - **색상은 hex가 아니라 `rt-c-*` 토큰** 사용(다크모드 적응 — 색 토큰 시스템 규칙).
- `widgets/index.js` `WIDGET_RENDERERS` 에 `fmea: { Icon: AlertTriangle, PropsPanel,
  Preview, Editor }` 등록 + import.

**내보내기 (필수 — 누락 주의)**
- PPT/Word 내보내기 핸들러(백그라운드 워커 `export_pptx`/`export_docx`)는 위젯 타입별
  렌더가 필요. **FMEA 위젯 렌더러를 내보내기 경로에도 추가**하지 않으면 보고서엔 보이는데
  PPT/Word엔 빠진다. (P1 완료조건에 포함)

**템플릿 시드** (`backend/scripts/seed_initial_data.py`)
- `TEMPLATES` 에 `fmea-analysis` 추가: 메타(key_value: 대상/팀/일자) + `fmea` 블록 +
  본문(rich_text, `#FMEA1` 참조 가능). 운영엔 시드 대신 **템플릿 디자이너 UI로 생성**도 가능.

**완료조건**: 템플릿에서 FMEA 보고서 작성 → S·O·D 입력 시 RPN 자동·색상 → 저장/검증 통과
→ 검색에 본문 색인 → PPT/Word 내보내기에 표 정상 출력.

**공수**: ~1.5~2주(프론트 위젯이 대부분; 내보내기 렌더 포함).

---

### Phase 2 — 과거 유사 FMEA/보고서 AI 추천 (LLM 불필요)

**목표**: FMEA 작성 중 고장모드/영향을 입력하면 **"예전에 비슷한 이슈" 과거 보고서를
자동 추천** — 지식 재활용. (이미 검증된 시맨틱 검색 엔진 재사용)

**구현**
- 백엔드: `GET /api/reports/{id}/related?block=fmea_items&row=<idx>` (또는 임시 텍스트
  기반 `?text=`) → `app/ai/search.py` 의 `semantic_search()` **그대로 호출**(질의 =
  해당 행의 고장모드+영향 텍스트). 권한은 `all_visible_report_ids` 재사용(권한 밖 미노출).
  자기 자신 보고서는 결과에서 제외.
- 프론트: `FmeaEditor` 행 옆 "유사 사례" 패널 — 추천 보고서 제목·유사도·스니펫,
  클릭 시 분할보기로 열기(멀티탭/분할 인프라 재사용). 디바운스로 호출 절약.
- 안전: 임베딩 비어도 하이브리드가 키워드로 degrade(기존 `embedding_hybrid_min_score`).

**완료조건**: 고장모드 입력 → 0.x초 내 유사 과거 보고서 3~5건 표시 → 클릭 열람.

**공수**: ~3~5일(엔진 존재, 얇은 API + 패널 UI).

---

### Phase 3 — FMEA 지식베이스 (행→엔티티 승격)

**목표**: FMEA를 "문서 안의 표"에서 **"조직 차원의 질의 가능한 데이터"** 로. RPN 대시보드,
횡단 검색("이 부품의 모든 고장모드", "RPN>100 전수").

**구현**
- 마이그레이션: `fmea_items` 투영 테이블 — `report_id(FK,CASCADE)`, `block_id`,
  `page_idx`, `row_id`, `failure_mode`, `severity/occurrence/detection`, `rpn`(파생),
  `status`, `responsible`, `updated_at` + 인덱스(`report_id`, `rpn`, `failure_mode trgm`).
- 동기화 훅: 보고서 저장 `after_commit`(search_text/임베딩과 **같은 chokepoint**)에서
  해당 보고서의 FMEA 행을 **delete+insert(교체식)** 로 투영. JSON이 원본, 테이블은 파생.
- API/화면: 부서/조직 **RPN 대시보드**(중점관리 항목 정렬, 상태별 집계), 횡단 필터 검색.
- 권한: 행 조회도 보고서 가시성에 종속(visible_report_ids join) — 누수 금지.

**완료조건**: "RPN>100" 한 화면 집계, 보고서 수정 시 테이블 자동 갱신, 권한 밖 행 미노출.

**공수**: ~2~3주(마이그·동기화 정합성·대시보드).

---

### Phase 4 — 액션(권고조치) 추적 & 재평가

**목표**: FMEA가 "분석"에서 "개선 실행 관리"로. 권고조치에 담당·기한·상태, 조치 후 재평가
RPN, 미결 알림.

**구현**
- P1 스키마의 `recommended_action/responsible/due_date/status/target_rpn` 활용 +
  P3 테이블에 조치 진행 칼럼. **재평가 RPN'**(조치 후 S·O·D) 컬럼 추가 → before/after 비교.
- 알림: 기한 임박/초과 미결 조치 → 담당자에게(알림 인프라 — `부족한부분.md` §1 알림 전달이
  선결; 인앱 알림만으로도 1차 가능). 백그라운드 워커 스케줄 잡으로 야간 스윕.
- 화면: "내 미결 FMEA 조치" 목록, 보고서 phase(작성/검토/완료)와 연계.

**완료조건**: 조치 상태 추적·재평가 RPN 비교·미결 알림.

**공수**: ~1.5~2주(알림 인프라 상태에 의존).

---

### Phase 5 — LLM 보조 (생성, B300/RAG Phase 3 후)

**목표**: 작성 자체를 가속 — 과거 유사사례를 근거로 **고장모드/원인/대책 제안**,
**유사 FMEA 기반 초안 자동 생성**, 심각도 추천.

**구현**
- RAG Q&A(Phase 3) 토대 위에서: 관련 청크 검색(P2 엔진) → LLM이 출처 인용과 함께 제안.
- 워커 핸들러 `suggest_fmea`(요약 핸들러와 동일 잡 패턴), 결과는 작성자가 검토·수정(드래프트).
- **반드시 인간 검토 게이트**(생성물 직접 확정 금지) — MCP 초안작성과 동일 안전원칙.

**의존**: B300 LLM + 네트워크(현재 미연결, `AI_RAG_현황.md` Phase 3).

---

## 5. 데이터 모델

**위젯 콘텐츠 JSON**(P1, 보고서 `content["fmea_items"]`):
```jsonc
{
  "fmea_items": {
    "caption": "구조 신뢰성 FMEA",
    "rows": [
      {
        "id": "r1",
        "failure_mode": "낙하 시 셀 모서리 응력 집중",
        "potential_effect": "셀 파손 → 발화 위험",
        "potential_cause": "모서리 보강 부재",
        "severity": 9, "occurrence": 3, "detection": 4,
        "rpn": 108,                       // 파생: S×O×D (클라 자동계산)
        "current_controls": "낙하 해석 검토",
        "recommended_action": "보강 브래킷 추가",
        "responsible": "구조팀", "due_date": "2026-07-31",
        "status": "open", "target_rpn": 36
      }
    ],
    "cell_styles": { /* RPN 임계 색상 등 */ }
  }
}
```

**투영 테이블**(P3, 파생·읽기전용):
```
fmea_items(id PK, report_id FK→reports(CASCADE), page_idx, block_id, row_id,
           failure_mode, potential_effect, severity, occurrence, detection,
           rpn, status, responsible, due_date, target_rpn, updated_at)
  idx: (report_id), (rpn), (failure_mode trgm), (status)
```

---

## 6. 횡단 관심사 (현 인프라 재사용/주의)

- **검증**: `WIDGET_REGISTRY` 기반 자동 — 위젯 등록만 하면 템플릿/콘텐츠 검증 동작.
- **임베딩/검색**: `text_extraction._collect` 자동 색인. 숫자칸 색인 여부만 결정(§7).
- **교차참조 번호**: `REF_CATEGORY_BY_TYPE["fmea"]` 등록 → 본문 `#FMEA1` 가능
  (미등록 시 import 실패 — 신규 위젯 공통 함정).
- **권한**: 검색·추천·P3 조회 모두 `visible_report_ids`/`all_visible_report_ids` 재사용
  — 권한 모델 신규 작성 금지(게시 누수 방지 원칙 유지).
- **내보내기(주의)**: PPT/Word 위젯 렌더에 FMEA 추가 필수(P1).
- **색상**: RPN/심각도 강조는 `rt-c-*` 토큰(다크모드·Tailwind purge 함정 회피).
- **백업/버전/휴지통/분할보기/로컬 자동백업**: 위젯 JSON에 얹으므로 전부 공짜로 상속.

---

## 7. 결정 필요 사항 / 리스크

1. **RPN vs AIAG-VDA AP** — classic RPN 기본 채택, AP는 옵션 컬럼으로? (도메인 합의 필요)
2. **평가척도 표준화** — S/O/D 1~10 기준표(룩업)를 사내 표준으로 고정할지(툴팁/가이드 제공).
3. **검색에 숫자 포함 여부** — RPN/점수를 search_text에 넣으면 "108" 검색 가능하나 노이즈
   우려 → 기본은 `_SKIP_KEYS` 로 제외(텍스트 의미검색에 집중) 권장.
4. **P3 동기화 정합성** — JSON↔테이블 드리프트 방지(교체식·after_commit 단일 경로·재색인
   배치 제공). 테이블은 어디까지나 파생.
5. **알림 인프라 의존(P4)** — 이메일/실시간은 `부족한부분.md` §1 선결. 인앱부터 시작.
6. **P5는 B300 선결** — 생성 기능은 네트워크/GPU 연결 전 착수 불가.

---

## 8. 파일 변경 맵 (P1~P2 핵심)

| 파일 | 변경 |
|---|---|
| `backend/app/widgets/registry.py` | `_fmea_content`, `FMEA` 디스크립터, `WIDGET_REGISTRY` 등록, `REF_CATEGORIES`/`REF_CATEGORY_BY_TYPE` 추가 |
| `backend/app/widgets/text_extraction.py` | (선택) 숫자칸 `_SKIP_KEYS` 추가 |
| `backend/scripts/seed_initial_data.py` | `fmea-analysis` 템플릿(또는 디자이너 UI 생성) |
| `frontend/src/modules/templates/widgets/FmeaAnalysis.jsx` | 신규 — PropsPanel/Preview/Editor, RPN 자동계산, 위험색상 |
| `frontend/src/modules/templates/widgets/index.js` | `WIDGET_RENDERERS.fmea` 등록 |
| 내보내기 렌더러(export_pptx/docx 경로) | FMEA 위젯 렌더 추가 |
| `backend/app/modules/reports/routes.py` + `app/ai/search.py` | P2: `/related` 엔드포인트(semantic_search 재사용) |
| `migrations/versions/pXX_fmea_items.py` (+ 모델/동기화 훅) | P3: 투영 테이블 |

---

## 관련 문서
- `AI_RAG_현황.md` — 임베딩·시맨틱/하이브리드 검색(P2·P5 토대), Ollama 배선
- `부족한부분.md` — FMEA 연관문서 추천을 도메인 킬러로 지목, 알림 인프라(P4)
- `약점보강_로드맵.md` — Dataset/멀티뷰 방향성(P3 엔티티화와 연결되는 큰 그림)
- 위젯 시스템: `app/widgets/registry.py`(REF_CATEGORY_BY_TYPE 함정), `text_extraction.py`
