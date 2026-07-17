# Phase D — 온톨로지 경보/트리거 (능동성) 설계

> 팔란티어 벤치마킹 로드맵의 **Phase D(의사결정 표면)** 중 **경보/트리거** 부분 설계.
> "묻지 않아도 시스템이 먼저 알린다" = 온톨로지가 **읽기 전용·수동 → 능동**으로.
> 배경: `[참고] 팔란티어 벤치마킹.md`(§4 Phase D), `[일부] AI검색_지능화_로드맵_설계.md`.
> 상태: **일부 구현** (갱신 2026-07-17). 통보 레이어까지 완성, **규칙 레이어가 얇다.**
>
> **구현됨:** 1 감지(v0.103, 마이그 p78, `alerts/services.py::run_rule` + diff 기계
> `diff_keys`) · 2 자동실행(v0.104, p79, `jobs/scheduler.py::run_alerts_scheduler_tick`,
> 매시간~매달) · 독립 관리자 페이지 `/admin/alerts`(v0.104.1) · 3a 관리자 인앱 알림
> (v0.105, p80, `_notify_new_firings`) · 3b 일일 이메일 다이제스트(v0.109, p82,
> `alerts/digest.py`) · 3c 작성자 통보(v0.110, p83, `_notify_owners`, 규칙별 옵트인
> `notify_owner`). 용어 '발화'→'감지'(v0.110.1).
>
> **⚠️ 잔여 — 릴리스 노트보다 얇다:**
> - **규칙이 2개뿐**(설계 §6 = 6개). `PROBES` = `untagged_reports`, `stale_unpublished`.
>   그나마 `stale_unpublished` 는 **설계 목록에 없는 즉흥 추가**이고, 설계의
>   `merge_candidates_backlog`·`connector_unresolved_links`·`stale_drafts`·
>   `pending_requests_aging`·`failed_jobs_backlog` 는 **미구현**.
> - **관리자가 규칙을 만들 수 없다** — `alerts/routes.py` 에 POST/DELETE 가 없어 시드된 2개를
>   켜고 끄는 것만 된다. **실질적으로 가장 큰 구멍.**
> - **`recipients` 모델이 스키마에 없다** — 설계 §5.1 의 `{mode, users, dept, derive}` 대신
>   `notify_owner` bool 하나뿐. 담당PL/부서 수신자 불가.
> - **작성자 이메일은 구조적으로 불가능** — `email_fanout.py` 가 `alert_firing` 이메일을 전부
>   억제하고, 유일한 이메일 경로인 다이제스트는 수신자를 `is_system_admin` 으로 거른다.
> - `escalate_after_minutes` 미구현 → `AlertRuleState.last_notified_at` 은 **아무도 안 읽는
>   죽은 컬럼**. 규칙별 `digest` 토글·`condition_kind`(`object_search`)·`created_by` 도 없음.
> - 드라이런(§5.4) 엔드포인트 없음. **시간여행·객체 대시보드**(§7) 코드 0줄.
>
> **⚠️ v0.110 이후 26개 릴리스 동안 방치됨** — 무게중심이 기준정보 관리·UI 로 옮겨갔다.
> 코드 주석(`services.py:7`·`models.py:27`·`routes.py:8`)이 아직 "1단계는 수동 실행만"
> 이라고 적혀 있으니 믿지 말 것.
>
> 이 문서로 Phase D 전용 설계 최초 분화.

---

## 0. 한 줄 요약

**규칙 = (조건) + (주기) + (수신자)** 를 저장 → 워커가 주기적으로 조건을 평가 →
**직전 발화집합과 diff** 해서 **새로 걸린 대상만** 알림/메일로 발화. 새 엔진은 만들지
않는다 — 객체 검색 DSL · 커넥터식 주기 스케줄러 · 알림/메일 큐를 **조립**한다.

---

## 1. 설계 원칙

- **재사용 우선** — 신규 엔진 0. 세 배관을 조립:
  - **조건 평가** = 기존 객체 검색(`search_entities` + `_prop_where`) **또는** 내장 프로브.
  - **주기 실행** = 커넥터 스케줄러 패턴(`next_run_at`/`_next_run_for`) 복제, `worker.py` 틱 추가.
  - **배달** = 알림 팬아웃 + 메일러 큐([[project_mailer_email]]) 재사용.
- **poll-first(주기 스캔 먼저), event-driven 나중** — §3 근거.
- **발화 상태(firing/resolved) 필수** — 이게 없으면 매 스캔마다 같은 알림 = 스팸. §4.
- **읽기 전용 유지** — MVP는 **알림까지만**. 객체에 플래그를 심는 write-back 은 Phase E.
- **데이터 있는 규칙부터** — 빈 데이터에 규칙 걸면 안 울려 "고장"으로 보임. §6 카탈로그가
  전부 "지금 데이터가 있는" 규칙인 이유.
- **신규 테이블 최소** — 2개(`alert_rules`, `alert_rule_state`)만. 나머지 재사용.

---

## 2. 조건은 두 종류 (핵심 결정)

A①·A② 실무 규칙 대부분은 **객체 속성 검색으로 표현이 안 된다**(미태깅 보고서=report_entities
조회, 정체 초안=draft 조회, 머지 후보=전용 함수). 그래서 조건을 둘로 나눈다 — **둘 다 같은
발화-상태 기계와 배달을 공유**한다:

| 조건 종류 | 무엇 | 표현 | UI | 주 용도 |
|---|---|---|---|---|
| `object_search` | 객체 속성/관계 임계 | `EntitySearchRequest` JSON | `ObjectSearch.jsx` 필터 빌더 재사용 | **B 쇼케이스**(RPN·시험실패) |
| `probe` | 위생·워크플로·운영 점검 | 내장 프로브 레지스트리(파라미터화) | 프로브 선택 + 임계 입력 | **A① 위생·A② 시간** |

- `object_search` → `search_entities` 결과 객체 각각이 발화 대상.
- `probe` → 프로브 함수가 `[{target_type, target_id, context}]` 리스트 반환, 각 항목이 발화 대상.
- 프로브는 **명시적 화이트리스트 레지스트리**(임의 SQL 금지). 새 점검은 코드로 추가.

> ⚠️ MVP 규칙 6개는 **전부 `probe`** 다(데이터가 지금 있는 건 위생·워크플로). `object_search`
> 규칙은 Phase B 로 구조화 데이터가 채워지면 그때 사용자가 필터 빌더로 직접 만든다.

---

## 3. 왜 주기 스캔(poll)을 먼저 하나

이벤트 훅(저장 시 규칙 평가)은 매력적이지만:
- **시간 기반 조건을 못 잡는다** — "마감 D-3", "N일째 미변경"은 아무 쓰기 이벤트 없이
  시간만 흘러 발화해야 한다. 이벤트 방식은 원리상 놓친다.
- **영향 매핑이 복잡** — "무엇이 바뀌면 어떤 규칙이 영향받나"를 정확히 라우팅해야.

커넥터 스케줄러가 이미 `next_run_at` 을 스캔하니 **같은 워커에 규칙 틱 하나만** 추가하면
끝이고, 지연 몇 분은 이런 경보에 무해하다. → **poll-first.** 즉시성이 필요한 특정 규칙만
후속으로 이벤트 훅 추가(예: 시험 결과 저장 → 즉시 평가).

---

## 4. 발화 상태 (firing / resolved) — 가장 중요한 부분

매 스캔 매칭에 알림을 쏘면 5분마다 같은 알림이 온다. 모니터링 시스템(Alertmanager)처럼
**대상별 발화 상태를 저장**한다:

```
alert_rule_state(rule_id, target_type, target_id, state, first_fired_at, last_seen_at, last_notified_at)
  PK (rule_id, target_type, target_id)
```

매 스캔:
- 결과에 **새로 진입** (state 없음) → **발화**(알림 1회), `state=firing`, `first_fired_at=now`.
- **계속 매칭** (state=firing) → 침묵. 단 `escalate_after` 지나면 재알림(옵션).
- 결과에서 **이탈** (state=firing 이나 이번 결과에 없음) → **해소**, `state=resolved`
  (옵션: "해소됨" 통지). 일정 후 정리.

이 diff 덕분에 **"상태 변화"**(시험 결과가 실패로 *바뀐 순간*, 새 미태깅 보고서가 *생긴 순간*)가
별도 구현 없이 공짜로 잡힌다.

---

## 5. 스키마 · 실행 · 배달

### 5.1 테이블 (신규 2개)

```
alert_rules(
  id, name, enabled,
  condition_kind,        -- 'object_search' | 'probe'
  condition,             -- JSONB: object_search=EntitySearchRequest / probe={probe_key, params}
  interval_minutes,      -- 주기(커넥터 _next_run_for 재사용)
  next_run_at,           -- due 스캔 대상
  severity,              -- 'info' | 'warn' | 'critical'
  recipients,            -- JSONB: {mode:'explicit'|'derived', users:[], dept, derive:'owner'|'led_by'|'dept_members'}
  escalate_after_minutes,-- null=재알림 안 함
  digest,                -- bool: 즉시 vs 다이제스트 묶음
  created_by, created_at, updated_at
)

alert_rule_state(  -- §4
  rule_id, target_type, target_id, state, first_fired_at, last_seen_at, last_notified_at
)
```

- `condition`/`recipients` 를 JSONB 로 두어 신규 컬럼 없이 확장.
- 마이그레이션: 다음 p번호(예: p78) 2 테이블 additive.

### 5.2 평가 루프 (`worker.py` 틱)

커넥터 스케줄러와 **동일 패턴**. `worker.py` main 루프(현 `Worker(concurrency, poll_ms)`)에
스케줄 스캔 틱을 얹거나 별도 코루틴:

```
매 tick:
  rules = select alert_rules where enabled and next_run_at <= now      # due
  for rule in rules:
    targets = evaluate(rule)          # object_search → search_entities / probe → registry[key](params)
    prev    = firing set from alert_rule_state(rule)
    for t in targets - prev:  fire(rule, t)          # 신규 진입 → 발화
    for t in prev - targets:  resolve(rule, t)       # 이탈 → 해소
    # 잔류는 escalate_after 지난 것만 재알림
    rule.next_run_at = _next_run_for('interval', rule.interval_minutes)
```

- `evaluate`/`fire` 는 순수화해 테스트 결정적(프로브·검색을 fake 주입).
- due 배치로 쿼리 몰림 완화. 속성 필터·report_entities 인덱스 활용.

### 5.3 배달

발화 → **알림 생성 + (옵션) 메일 큐 적재**(기존 재사용). 수신자 해석:
- `explicit` — 규칙에 지정된 사용자/부서.
- `derived` — **대상 객체에서 파생**(system 투영·led_by 재사용): 보고서 작성자(owner),
  과제 담당 PL(led_by user), 소속 부서 멤버(dept_members).
- **가시성 게이트** — 파생 수신자가 못 보는 보고서/객체 경보가 새지 않도록 배달 시 확인
  ([[project_grant_visibility_model]] 재사용). MVP 는 안전하게 `explicit` 우선.
- `digest=true` 면 즉시 발송 대신 다이제스트 버킷에 모아 주기 발송(메일러 다이제스트).

### 5.4 관리 UI

- **"경보 규칙" 탭**(AI설정 또는 온톨로지 관리): 규칙 목록·on/off·주기·심각도·수신자.
  - 조건 편집: `probe` = 프로브 드롭다운 + 임계 파라미터 폼 / `object_search` = `ObjectSearch`
    필터 빌더 임베드.
- **발화 인박스**: 현재 `firing` 경보 목록(대상·언제부터·심각도), 클릭 → 대상 프로필/보고서.
- 규칙 **드라이런**("지금 돌리면 몇 건 걸리나") — 임계 튜닝용, 상태 안 남김.

---

## 6. MVP 규칙 카탈로그 — **실제로 넣을 규칙 (전부 `probe`, 데이터 있음)**

각 규칙 = 내장 프로브. 임계는 파라미터(관리자 조정). **전부 지금 데이터가 있어 첫날부터 울린다.**

### A① 데이터 위생 / 온톨로지 밀도 (플라이휠 — 경보가 온톨로지를 채우게 만듦)

**1. 미태깅 보고서** `probe: untagged_reports`
- **무엇**: `report_entities` 가 0건인 보고서가 생성 후 **N일**(기본 7) 경과.
- **backing**: reports ⟕ report_entities(없음) + `created_at`. 휴지통·초안 제외.
- **대상/수신자**: 대상=보고서 → 파생 owner(작성자) 또는 부서 관리자. **심각도 info.**
- **왜**: 연결 안 된 보고서는 검색·GraphRAG·에이전트에서 안 보임 → 채우도록 유도.
- *변형*: `suggest_entities(db, report)` 추천이 있는데 미승인 → "추천 태그 대기".

**2. 머지 후보 적체** `probe: merge_candidates_backlog`
- **무엇**: `find_merge_candidates(...)` 결과(중복 의심 쌍)가 **N건**(기본 10) 이상.
- **backing**: `entities/merge_candidates.py::find_merge_candidates`(온플라이 — 저장 아님).
- **대상/수신자**: 대상=후보 집합 → 온톨로지 관리자. **심각도 warn.**
- **왜**: 중복 엔티티는 그래프·집계를 오염. 검토를 밀어줌.

**3. 커넥터 미해결 링크 적체** `probe: connector_unresolved_links`
- **무엇**: 최근 동기화의 `link_unresolved`(대상 못 찾아 링크 건너뜀) 누적 **N건**(기본 20).
- **backing**: 커넥터/임포트 결과 카운터(`import_service.py`·`connectors/services.py` 의
  `link_unresolved`). 데이터소스별 집계.
- **대상/수신자**: 대상=데이터소스 → 커넥터 관리자. **심각도 warn.**
- **왜**: 외부 유입이 온톨로지에 안 붙고 유실됨 → 코드 매핑 보정 유도.

### A② 시간 / 워크플로 (마감·정체 — 데이터 있음)

**4. 정체된 내 초안** `probe: stale_drafts`
- **무엇**: 사용자 초안(AiDraft)이 마지막 수정 후 **N일**(기본 14) 미제출.
- **backing**: drafts(`list_my_drafts` 계열) + `updated_at`.
- **대상/수신자**: 대상=초안 → **본인**(개인 알림). **심각도 info, digest 권장.**
- **왜**: 작성하다 방치한 초안 회수.

**5. 승인/게시취소 요청 대기** `probe: pending_requests_aging`
- **무엇**: 게시취소·삭제 요청 큐(또는 비밀번호 재설정 요청 큐) 항목이 **N일**(기본 3) 미처리.
- **backing**: [[project_report_deletion_design]] 요청 큐 + [[project_password_recovery]] 요청 큐.
- **대상/수신자**: 대상=요청 → 승인 권한자(매니저/관리자). **심각도 warn.**
- **왜**: 승인 병목으로 사용자가 막힘.

**6. 실패 잡 적체** `probe: failed_jobs_backlog`
- **무엇**: 작업 큐 실패 잡이 최근 창에서 **N건**(기본 5) 이상, 또는 워커/LLM 하트비트 down.
- **backing**: jobs 모듈 + [[project_job_queue_admin]] 통계·하트비트.
- **대상/수신자**: 대상=큐 상태 → 시스템 관리자. **심각도 critical.**
- **왜**: 임베딩·메일·동기화 등 백그라운드 파이프라인 중단 조기 감지.

> **채택 규칙 = 위 6개.** 1·2·3 은 온톨로지를 채우는 플라이휠, 4·5·6 은 워크플로/운영
> 병목. **B 쇼케이스(RPN 임계·시험 실패→과제 플래그)는 Phase B 로 구조화 데이터가
> 채워질 때 `object_search` 규칙으로 추가** — 엔진 변경 없이 규칙만 늘린다.

---

## 7. 나중으로 (선긋기)

- **`object_search` 도메인 규칙** — RPN 임계·시험 실패·공급사 지표. **Phase B 데이터 선행.**
- **시간 상대 연산자**(`today±N`) — 현 date 필터는 리터럴만. 마감 경보를 `object_search`로도
  하려면 `_prop_where` 에 상대일 비교 추가(프로브 4·5 는 이미 코드로 처리하므로 MVP 무관).
- **집계형 규칙**("부서별 실패율 > 20%") — per-대상 아님 → `structured_qa.aggregate` 를 조건
  백엔드로 붙이는 별도 트랙.
- **관계 넘는 다홉 조건**("실패 시험에 물린 과제") — 검색 관계 필터로 일부, 다홉은 후속.
- **그래프에 플래그 심기**(객체 status='flagged') — **쓰기 = Phase E**. 능동성은 알림까지만.
- **이벤트 훅**(즉시 발화) · **개인 구독**("이 객체 지켜보기") · **시간여행/대시보드**(Phase D 나머지).

---

## 8. 리스크

- **알림 피로** — firing-state dedup(§4) 필수 + 심각도 + `digest` 묶음. 규칙별 재알림 억제.
- **데이터 밀도 의존** — 카탈로그를 "데이터 있는 위생·워크플로"로 한정해 회피.
- **비용** — 규칙마다 매 주기 쿼리 → due 배치 + 인덱스. 프로브는 가벼운 카운트 위주.
- **가시성 유출** — 파생 수신자 배달 시 가시성 게이트. MVP 는 `explicit` 우선.
- **프로브 남용** — 임의 SQL 금지, 화이트리스트 레지스트리로만.

---

## 9. 검증

- 백엔드 `test_alerts.py` — 프로브 평가(fake 데이터), **firing→침묵→resolved 상태 전이**,
  신규 진입만 발화(재알림 안 됨), 배달 수신자 해석(explicit/derived), 가시성 게이트, due 스케줄.
- 워커 틱: 프로브·검색 fake 주입해 결정적. 실 LLM 불필요.
- 프론트: eslint + esbuild, 육안(규칙 생성→드라이런→발화 인박스→대상 프로필 이동).

## 10. 릴리스

마이너 범프 + `[참고] 업데이트내용.md` + 커밋 분할(마이그/프로브+평가/배달/워커틱/UI).
프로브 6개는 게이트 없이 안전(알림만). 착수 시 이 문서를 진행현황 블록으로 갱신.

---

## 11. 열린 결정 (착수 전)

- 규칙 소유: **관리자 전역**부터(개인 watch 후속) — 동의?
- 스캔 위치: `worker.py` 기존 루프에 틱 추가 vs 별도 스케줄러 코루틴.
- 기본 주기: 위생/워크플로는 **시간~일 단위**로 충분(분 단위 불필요) — 기본 60분?
- "해소됨" 통지를 MVP 에 넣을지(넣으면 노이즈↑, 빼면 상태만 정리).
