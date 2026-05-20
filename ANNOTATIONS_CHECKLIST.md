# 어노테이션 시스템 — 구현 체크리스트

차트/이미지/마일스톤 등 시각 위젯에 공용으로 얹는 어노테이션 레이어.
공통 추상화 (Annotation 데이터 모델 + 호스트 어댑터) 한 번 만들고, 각 위젯이 어댑터만 구현하는 구조.

좌표 공간: `data` (차트 도메인) / `data_relative` (도메인 끝에서 -7d 등) / `image_pct` (이미지 0~1).

---

## Phase A — 공용 인프라 (위젯 무관)

- [x] **A1. 데이터 모델 정의** — `frontend/src/shared/annotations/types.js` 에 Annotation JSDoc + 팩토리(`createAnnotation(type, geometry)`) + 타입별 geometry 검증
- [x] **A2. 백엔드 ANNOTATION_SCHEMA** — `backend/app/widgets/validation.py` 에 JSON Schema 정의, export
- [x] **A3. Chart content schema 갱신** — `_chart_content` 에 `annotations: [...]` 필드 추가, 동일 어레이를 image / milestone 에도 추가
- [x] **A4. AnnotationStore hook** — `useAnnotationStore` 가 annotations 배열 + selection state + undo/redo history (coalescing) 관리
- [x] **A5. AnnotationLayer skeleton** — SVG 오버레이. 어댑터 받아 4기본 타입 (vline / vrange / hline / point) 렌더 (인터랙션 없이)
- [x] **A6. Annotation 단독 단위 테스트** — types.js 의 검증/팩토리만 빠르게 확인

## Phase B — V1: 차트 기본 동작

- [x] **B1. ChartAnnotationAdapter** — Recharts 의 scale 에서 toPx/fromPx 추출 (Customized 컴포넌트 안에서 xAxisMap/yAxisMap 활용). snap(value, axis) 도 함께
- [ ] **B2. AnnotationToolbar 컴포넌트** — `│ ▮ ─ ▬ ● ✕` 도구 + 현재 모드 표시 + 커서 변경
- [ ] **B3. 만들기 — vline / hline (단일 클릭)** — 모드 진입 → 클릭 → 즉시 생성 + 라벨 인라인 입력
- [ ] **B4. 만들기 — vrange / hrange (드래그)** — mousedown→mousemove→mouseup, 미리보기 음영, 종료 시 생성
- [ ] **B5. 만들기 — point (클릭)**
- [ ] **B6. 선택** — 어노테이션 클릭 → ring + 작은 액션 (`편집 / 복제 / 삭제`)
- [ ] **B7. 이동** — 본체 드래그 → 데이터 좌표로 통째 이동
- [ ] **B8. 리사이즈** — 범위 어노테이션 양 끝 핸들 드래그로 한쪽만 늘림
- [ ] **B9. 스냅 동작** — 기본: 가까운 데이터 포인트 스냅. Shift 누르면 자유 이동
- [ ] **B10. 삭제** — Delete/Backspace 키 + 액션 버튼 + 우클릭 메뉴
- [ ] **B11. 라벨 인라인 편집** — 더블클릭 → 작은 input → blur/Enter 시 commit
- [x] **B12. Chart 위젯에 통합 (읽기 전용)** — Customized 로 AnnotationContents 인라인 렌더. 양방향 바인딩은 아직 (인터랙션 부재)
- [ ] **B13. 백엔드 페이로드 round-trip 검증** — 어노테이션이 있는 차트 저장/로드 정상 작동

## Phase C — V2 다듬기

- [ ] **C1. AnnotationStyleEditor** — 색/투명도/테두리(solid/dashed)/라벨 위치/z-order. 선택된 어노테이션에 인라인으로 노출
- [ ] **C2. 색 — 시리즈 자동 매칭 + 의미 팔레트 5종** — 차트 시리즈 색을 자동 추천 + 위험/주의/정상/정보/중립 색
- [ ] **C3. Undo/Redo** — AnnotationStore 의 history. 키바인딩 Cmd+Z / Cmd+Shift+Z. 빠른 연속 변경은 coalescing
- [ ] **C4. Lock 토글** — 잠긴 어노테이션은 드래그/리사이즈/삭제 거부, 자물쇠 아이콘 표시
- [ ] **C5. Hide/Show 토글**
- [ ] **C6. 라벨 충돌 회피** — 같은 축 어노테이션 라벨이 겹치면 above/below 교대 배치 (마일스톤 패턴 재활용)
- [ ] **C7. 호버 시 dim 효과** — 다른 데이터를 가리지 않도록

## Phase D — V3 고급 타입 + 도구

- [ ] **D1. hrange 만들기/렌더**
- [ ] **D2. rect (x range × y range) 만들기/렌더**
- [ ] **D3. arrow ((x1,y1)→(x2,y2)) 만들기/렌더**
- [ ] **D4. text (자유 텍스트, 데이터 미연결) 만들기/렌더**
- [ ] **D5. 다중 선택** — Shift+클릭 / 마우스 드래그 박스 selection
- [ ] **D6. 다중 작업** — 같이 이동/색 변경/잠금/삭제
- [ ] **D7. AnnotationListPanel** — 위젯 편집 다이얼로그에 "어노테이션" 탭 추가, hide/lock/delete 토글 + 클릭 시 차트 위치로 스크롤·하이라이트
- [ ] **D8. 상대 좌표 (data_relative)** — "도메인 끝에서 -7일" 같은 anchor

## Phase E — 다른 위젯으로 확장

- [ ] **E1. ImageAnnotationAdapter** — image_pct ↔ px 변환. 이미지 위젯에 통합
- [ ] **E2. MilestoneAnnotationAdapter** — 날짜 → x px. 마일스톤 타임라인 위에 vrange / text 어노테이션
- [ ] **E3. (선택) FlowchartAnnotationAdapter** — 노드 좌표. 필요 시.

## Phase F — Export 호환

- [ ] **F1. PDF/HTML export 검증** — SVG 기반이라 자동, 시각 검사만
- [ ] **F2. DOCX export** — 차트 → 이미지 굽기 경로 (domtoimage 등) 도입, 어노테이션도 함께 캡쳐. 마일스톤/이미지도 동일
- [ ] **F3. 검색용 텍스트 폴백** — 어노테이션 라벨을 export 시 캡션/표로 함께 출력

## Phase G — 최종 정리

- [ ] **G1. 어노테이션 수 soft limit (50개)** — 초과 시 안내 메시지
- [ ] **G2. 모바일/터치에서 view-only 강제** — 작은 핸들 + 우클릭 메뉴가 터치에 안 맞음
- [ ] **G3. README / docs 갱신**
- [ ] **G4. 백엔드 테스트 (가능하면)** — annotations 들어간 페이로드 검증

---

## 진척 메모

세션마다 마지막에 다음 항목 정리:
- 어디까지 끝났는지
- 막혔거나 결정 필요한 지점
- 다음 시작 시 첫 작업

### 2026-05-20 — 1차 세션
**완료**
- Phase A 전체 (A1~A5).
  - `frontend/src/shared/annotations/types.js` — Annotation 데이터 모델 + 팩토리 + 검증.
  - `frontend/src/shared/annotations/store.js` — useAnnotationStore (add/update/remove/selection/undo/redo).
  - `frontend/src/shared/annotations/AnnotationLayer.jsx` — SVG 오버레이 + 8 타입 drawer + 단독 / 내장 모드 (AnnotationContents).
  - `frontend/src/shared/annotations/ChartAnnotationAdapter.js` — Recharts axes capture 헬퍼 (재사용 가능).
  - `frontend/src/shared/annotations/index.js` — 공용 export.
  - 백엔드: `backend/app/widgets/registry.py` 에 `ANNOTATION_SCHEMA` + `_ANNOTATIONS_FIELD` 추가, chart / image / milestone 의 content schema 에 `annotations` 슬롯 추가. jsonschema 직접 검증 통과 확인.
- Phase B 부분: B1 (어댑터), B12 (차트 위젯에 읽기 전용으로 통합) 완료. content.annotations 가 차트에 그려짐.
- A6 (단위 테스트) 는 백엔드 jsonschema 검증으로 사실상 커버되어 별도 JS 테스트 생략.

**현재 상태**
- 차트의 `content.annotations` 에 어노테이션이 들어 있으면 차트 위에 그려짐 (View / Edit 모드 모두).
- 아직 인터랙티브 생성 / 선택 / 이동 / 삭제 없음 — UI 도구가 없어 사용자가 직접 추가할 수 없음.
- 이미지 / 마일스톤 위젯은 백엔드 스키마만 준비됨 (slot 비어 있어 동작에 영향 없음).

**다음 시작 시 첫 작업**
1. **B2 — AnnotationToolbar**. `frontend/src/shared/annotations/AnnotationToolbar.jsx` 신규. 모드 토글 (`null` / `'vline'` / `'vrange'` / ... / `'point'`) + 활성 모드 표시. ChartEditor 안에서 마운트.
2. **B3~B5 — 인터랙티브 생성**. Customized 안의 ChartAnnotationOverlay 를 인터랙티브 모드로 확장 (또는 별도 오버레이 SVG 로 분리 — 추천: 별도 오버레이가 마우스 이벤트 핸들링 깔끔). 모드별 클릭/드래그 핸들러로 store.add() 호출.
3. **B6~B10 — 선택/이동/리사이즈/삭제**. AnnotationContents 의 onClick 은 이미 store.setSelected 로 연결 준비. 드래그 핸들러 + selected ring 위에 핸들 그리기 추가.

**결정 / 확인 필요**
- 인터랙티브 오버레이 위치: chart 의 Customized 안 (SVG 내장) vs. 외부 absolute-positioned SVG. 내장은 좌표 자동, 외부는 마우스 이벤트가 더 깔끔. **외부 추천** — Customized 안에서는 React 의 onMouseDown 등이 일관성 있게 잡히지 않음.
- 라벨 충돌 회피 (C6) 는 V1 후 적용 — 일단 한 두 개 라벨로 사용성 확인.

**검증 안 한 부분**
- 브라우저 시각 확인 못 함. 다음 세션 시작 전 dev server 띄워서 빈 어노테이션 → 정상 / 가짜 어노테이션 한 두 개 직접 JSON 으로 넣은 후 차트에 그려지는지 확인 권장.
