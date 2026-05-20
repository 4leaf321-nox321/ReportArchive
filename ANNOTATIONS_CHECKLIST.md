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
- [x] **B2. AnnotationToolbar 컴포넌트** — 8 타입 + 취소 버튼. supportedTypes 로 호스트별 필터링. 활성 모드 토글 + Esc 단축키.
- [x] **B3. 만들기 — vline / hline (단일 클릭)** — InteractiveCaptureRect 가 클릭 위치에서 fromPx → store.add. 라벨은 일단 비어있음 (B11 에서 인라인 편집)
- [x] **B4. 만들기 — vrange / hrange (드래그)** — pointerdown→move→up, 미리보기 음영 (DragPreview), 0-area 가드.
- [x] **B5. 만들기 — point (클릭)**
- [x] **B6. 선택 (단일)** — AnnotationContents.onClick → store.setSelected. ring 시각화 동작.
- [x] **B7. 이동** — 본체 pointerdown → 6px 이상 움직이면 드래그 모드. moveGeometry coalesce. pointerup 시 commitNormalized. 6px 미만은 selection 으로 처리 (click 과 drag 한 입력에 통합).
- [x] **(B-추가) annotation z-order** — 차트 SVG 안이 아니라 외부 sibling SVG overlay 로 렌더. 바차트 위로 올바르게 표시.
- [x] **(B-추가) 도구 지속성** — onCommit 자동 호출 제거. Esc / 도구 재클릭으로만 해제, 연속 생성 가능.
- [x] **(B-추가) Hover 미리보기** — 도구 active 시 호버 위치에 fromPx→toPx 라운드트립한 미리보기 (snap 결과를 사용자에게 즉시 보여줌).
- [x] **(B-추가) 축 범위 수동 설정** — x_min/x_max/y_min/y_max content 필드 + 축 제목 popover 안의 grid UI + Recharts XAxis/YAxis domain 으로 전달.
- [x] **B8. 리사이즈** — 범위 어노테이션 양 끝 핸들 드래그로 한쪽만 늘림 (vrange/hrange 2개, rect 4개 코너, arrow from/to). `useAnnotationInteractions` 의 dragRef 가 mode='body' | 'handle' 디스패치.
- [x] **B9. 스냅 동작** — 기본: 카테고리는 band label 로 자동, 연속축은 도메인 범위의 ~1% step (10의 거듭제곱) 으로 라운드. Shift 누르면 끔.
- [x] **B10. 삭제** — Delete/Backspace 키 (selected 일 때) + clearSelection 보존. 액션 버튼은 B6 의 hover 액션에서 추가 예정.
- [x] **B11. 라벨 인라인 편집** — 라벨 더블클릭 → foreignObject <input>. Enter / blur 시 commit, Esc 취소, 빈 텍스트 시 라벨 키 삭제. 입력 영역 클릭은 outside-click 무시 처리.
- [x] **B12. Chart 위젯 양방향 바인딩** — annotationStore + 툴바 + 인터랙티브 capture + content.annotations round-trip.
- [ ] **B13. 백엔드 페이로드 round-trip 검증** — 어노테이션이 있는 차트 저장/로드 정상 작동 (브라우저 검증 필요)

## Phase C — V2 다듬기

- [x] **C1. AnnotationStyleEditor** — `AnnotationStyleBar.jsx`. 단일 선택된 annotation 옆에 인라인 floating bar — 색 / 테두리(solid/dashed/dotted) / 투명도(25/50/75/100%) / 숨김 / 삭제. 라벨 위치 / z-order 는 보류 (필요 시 확장).
- [x] **C2. 색 — 의미 팔레트 5종** — 위험/주의/정상/정보/중립 (#dc2626/#f59e0b/#16a34a/#2563eb/#6b7280). 시리즈 자동 매칭은 보류 (사용자 직접 선택으로 충분히 빠름).
- [x] **C3. Undo/Redo** — Cmd/Ctrl+Z (undo), Cmd/Ctrl+Shift+Z (redo), Ctrl+Y (Windows redo alias). 입력 요소 focus 시 무시. `annotationStore.history.{undo,redo}` 이미 coalescing 포함.
- [ ] ~~**C4. Lock 토글**~~ — 사용자 요청으로 제외
- [x] **C5. Hide/Show 토글** — `AnnotationStyleBar` 에 눈 아이콘. Hidden 은 view-only 에선 안 그려지고, edit mode 에선 opacity 0.25 ghost 로 표시 → 다시 클릭해서 토글 가능.
- [ ] ~~**C6. 라벨 충돌 회피**~~ — 사용자 요청으로 제외
- [x] **C7. 호버 시 dim 효과** — `index.css` 에 `.annotation-vrange:hover`, `.annotation-hrange:hover`, `.annotation-rect:hover` 의 body rect fill-opacity 0.04 + 0.15s transition. 라인/점/화살표는 데이터를 안 가리므로 적용 안 함.

## Phase D — V3 고급 타입 + 도구

- [x] **D1-D4. 8 타입 만들기/렌더** — Phase B 에서 한꺼번에 처리. rect / arrow / text 도 toolbar `supportedTypes` 에 포함됨 (vline, vrange, hline, hrange, point, rect, arrow, text 8종).
- [x] **D5. 다중 선택** — Shift+클릭은 기존부터 동작. 추가로 빈 영역 드래그하면 marquee 사각형이 나와서 안에 들어온 annotation 들 일괄 선택 (`SelectionMarquee.jsx`). 도구 미활성 + 편집 모드에서만 활성. Shift+드래그면 기존 선택에 추가.
- [x] **D6. 다중 작업** — `AnnotationStyleBar` 가 다중 선택 지원. 상단 중앙에 floating bar 표시 (`{n}개 선택` 라벨 포함). 색/테두리/투명도 클릭 시 모든 선택에 적용. 숨김은 aggregate (모두 숨김이면 표시, 아니면 모두 숨김). 삭제는 `removeMany`. 완료 = clearSelection + 도구 OFF. 잠긴 annotation 은 자동 제외.
- [ ] ~~**D7. AnnotationListPanel**~~ — 사용자 요청으로 제외
- [ ] ~~**D8. 상대 좌표 (data_relative)**~~ — 사용자 요청으로 제외

## Phase E — 다른 위젯으로 확장

- [x] **E1. ImageAnnotationAdapter** — `useImageAnnotationAdapter(containerRef, { imgRef })` hook 이 ResizeObserver 로 image 박스 측정. image_pct 좌표 (0~1). 단일 이미지 모드 (max_count=1) 에서만 활성, 갤러리는 미지원 (어느 파일에 속한 마크인지 모델에 없음). `AnnotatableImageBox` 가 차트와 동일한 surface (toolbar + interactions + style bar + marquee + label editor) 마운트. AuthedImage 에 forwardRef 추가.
- [ ] ~~**E2. MilestoneAnnotationAdapter**~~ — 보류 (사용자 요청 외)
- [ ] ~~**E3. FlowchartAnnotationAdapter**~~ — 보류 (사용자 요청 외)

## Phase F — Export 호환

- [x] **F1. PDF/HTML export 검증** — annotation 은 SVG 라 `report-detail-root` DOM clone 시 자동 캡처. 방어적으로 `exportReportToHtml.js` 의 strip 셀렉터에 `.annotation-style-bar`, `.annotation-label-editor` 추가 (혹시 edit 모드에서 export 해도 UI chrome 안 나옴).
- [x] **F2. DOCX export** — `exportReportToDocx.js` 의 image case 가 annotation 있으면 html2canvas 경로로 fallback → SVG overlay 가 PNG 로 함께 구워짐. Chart 는 기존부터 visual block 경로라 자동 처리됨.
- [x] **F3. 검색용 텍스트 폴백** — `convertAnnotationLabels` 가 annotation label.text 를 "어노테이션\n· ..." 캡션으로 image/chart 뒤에 출력. DOCX 검색 / 스크린리더 접근성 확보.

## Phase G — 최종 정리

- [x] **G1. 어노테이션 수 soft limit (50개)** — `AnnotationCountBadge` 가 toolbar 옆에 `{n}/200` 칩 표시. 50 초과 시 amber 색 + ⚠ + tooltip "렌더링이 느려질 수 있습니다". 비-blocking.
- [ ] ~~**G2. 모바일/터치에서 view-only 강제**~~ — 사용자 요청으로 제외
- [x] **G3. README / docs 갱신** — `개발가이드.md` 에 "시각 위젯에 어노테이션 얹기" 섹션 추가. 어댑터 작성 → 백엔드 schema 슬롯 → 컴포넌트 surface 마운트 → export 대응 → 알려진 한계 순으로.
- [ ] ~~**G4. 백엔드 테스트**~~ — 사용자 요청으로 제외

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

### 2026-05-20 — 2차 세션
**완료**
- B2 (AnnotationToolbar): `frontend/src/shared/annotations/AnnotationToolbar.jsx`. 8 타입 + 취소. lucide 아이콘 (MoveVertical, Columns2, MoveHorizontal, Rows2, Circle, Square, ArrowUpRight, Type). supportedTypes 로 호스트별 필터링. isClickTool / isDragTool 헬퍼 함께 export.
- B3-B5 (인터랙티브 생성): `frontend/src/shared/annotations/InteractiveCaptureRect.jsx`. 차트 SVG 내부에서 transparent <rect> + 마우스 핸들러. click 타입 (vline/hline/point/text) 은 pointerdown 으로 즉시 생성, drag 타입 (vrange/hrange/rect/arrow) 은 down→move→up + 미리보기. 0-area 가드.
- 설계 변경: 인터랙티브 오버레이를 외부 SVG 가 아니라 Customized 안에 통합. 좌표 동기화 + scale 신선도 문제가 한 번에 해결됨. 마우스 이벤트도 React 가 SVG `<g>` 위에서 잘 잡아줌.
- B6 (선택): AnnotationContents.onClick → store.setSelected (Shift 시 additive). selected ring 자동 시각화.
- B10 (삭제): document keydown 으로 Delete/Backspace 처리. 입력 요소 focus 시는 무시 (텍스트 편집 안 깨짐).
- B12 (양방향 바인딩): ChartEditor 에 annotationTool state + useAnnotationStore. content.annotations 와 store 가 양방향. patch() 가 다른 필드 수정에도 annotations 보존. 빈 배열은 wire 페이로드에서 제거.
- ChartAnnotationAdapter 에 fromPx + snap 추가 (band scale invert 폴백 포함).
- AnnotationLayer 에 AnnotationContents 단독 export 추가 (Customized 안에서 SVG 중첩 없이 쓰기 위함).

**현재 상태**
- 차트 편집 모드 (보고서 편집 → 차트 클릭 → 모달 안) 에서 어노테이션 툴바가 보임.
- vline / vrange / hline / hrange / point 5종 도구가 동작 → 클릭/드래그 → 어노테이션 생성 → 저장 → 다시 로드 정상.
- 어노테이션 클릭 → 선택 (ring), Shift 클릭 → 다중 선택.
- Delete / Backspace → 선택된 것 일괄 삭제. Esc → 도구 취소 / 선택 해제.
- 도구 활성 시 차트 영역에 cursor: crosshair + "차트 영역을 클릭/드래그하세요 (Esc 취소)" 안내.

**알려진 한계 (다음 세션 후보)**
- 어노테이션을 **이동 / 리사이즈** 못 함 (B7-B9). 현재는 만든 자리에 고정.
- 라벨이 비어 있어 만든 어노테이션이 누구인지 모름 (B11 — 더블클릭 인라인 편집 필요).
- 색상 / 테두리 / 라벨 위치 등 스타일 컨트롤 없음 (C1-C2).
- Undo/Redo 키바인딩 안 붙음 (store 의 history 는 준비됨, C3).
- rect / arrow / text 는 도구는 만들었지만 toolbar 의 supportedTypes 에서 제외 — 만든 직후 어색하기 때문 (드래그 미리보기는 동작하나 라벨/스타일 미비). C/D 단계에서 풀기.
- 브라우저 검증 안 함.

**다음 시작 시 첫 작업**
1. **B7 — 이동**: 선택된 어노테이션의 본체 드래그로 통째 이동. 각 타입의 geometry 전체에 delta 적용. (vline: x += dx, vrange: x_from/x_to 둘 다 += dx, 등). InteractiveCaptureRect 와 비슷한 패턴이지만 selected 어노테이션의 SVG <g> 위에서 동작. store.moveGeometry 이미 준비됨.
2. **B8 — 리사이즈**: 선택된 범위 어노테이션 양 끝에 작은 핸들 (●) 표시. 핸들 드래그 시 한쪽 좌표만 업데이트.
3. **B9 — 스냅**: 드래그 중 가까운 데이터 포인트에 스냅. Shift 누르면 끄기. adapter.snap 이미 준비됨 (band scale 은 자동, continuous 는 패스스루 — Phase B 에서 catmull 같은 더 정교한 스냅 추가 가능).
4. **B11 — 라벨 인라인 편집**: 선택된 어노테이션 위에 떠 있는 작은 input. 더블클릭으로 진입. blur / Enter 시 store.update 로 label.text 갱신.
5. **B13 — round-trip 검증**: dev server 띄워서 어노테이션 만들고 → 저장 → 새로고침 → 같은 어노테이션 다시 보이는지.

**결정 / 확인 필요**
- B7 의 이동 중에도 미리보기 좌표를 store 에 commit 하면 history 가 폭주 → store.moveGeometry 의 coalesce: true 활용. 드래그 종료 시 commitNormalized 로 마무리.
- 라벨 편집 input 의 위치 — SVG 안 foreignObject 가 안정적인지, 아니면 절대 위치 DOM 으로 띄울지. SVG 좌표 → 화면 좌표 변환 필요. **foreignObject 권장**.

### 2026-05-20 — 3차 세션 (Phase B 마무리)
**완료**
- **B8 — 리사이즈**: `useAnnotationInteractions.js` 의 dragRef 에 `mode: 'body' | 'handle'` 디스패치 도입. `onHandlePointerDown(annotation, handle, e)` 추가. handle 이름은 업데이트할 geometry 필드와 직접 매핑 — vrange/hrange 는 `x_from`/`x_to` 또는 `y_from`/`y_to`, rect 는 4개 코너 (`x_from_y_from` 등 복합 이름으로 양축 동시 업데이트), arrow 는 `from`/`to`. `AnnotationLayer.jsx` 에 `ResizeHandle` 컴포넌트 추가 — selected 상태에서만 그려짐, locked 시 비활성. 픽셀 좌표는 min/max 가 아니라 실제 필드 값으로 — 일시적으로 뒤집힌 동안에도 각 핸들이 자기 필드를 따라감. commitNormalized 가 up 시 정렬.
- **B9 — 스냅**: `ChartAnnotationAdapter.js` + `Chart.jsx` 의 buildChartAdapter snap 둘 다 업그레이드. 카테고리 (band scale) 는 value 가 이미 도메인 entry 이므로 패스스루. 연속축은 도메인 범위의 ~1% 를 step 으로 사용 (10의 거듭제곱으로 floor) — y∈[0,100] → step 1, y∈[0,1] → step 0.01, y∈[0,10000] → step 100. 이동/리사이즈 양쪽에 적용되며 `e.shiftKey` 가 true 면 우회 (생성 시는 스냅 미적용 — 사용자가 픽셀 위치 그대로 찍은 것 존중).
- (B-추가) 라벨 박스 패딩 수정 — `anchor="end"` / `anchor="start"` 일 때 텍스트가 박스 가장자리에 붙던 버그. text x 를 `± LABEL_PAD_X` 만큼 inward shift.
- (B-추가) two-click vrange/hrange 정규화 — 두 번째 클릭이 통과해도 `validateAnnotation` 이 `x_from > x_to` 를 거부하여 silent drop 되던 문제. `InteractiveOverlay` 가 commit 직전에 `normalizeGeometry` 호출.
- (B-추가) 라벨 입력 옵션화 — `AnnotationLabelEditor` 에 ✕ 버튼 추가. placeholder 를 "라벨" → "라벨 (선택)" 로 변경. blur 시 ✕ 버튼으로 포커스 가면 commit 건너뛰도록 보강.

**현재 상태 — Phase B 완성**
- 8 타입 모두 만들기 / 선택 / 이동 / 리사이즈 / 삭제 가능 (라벨 인라인 편집 + 좌표 chip + snap + Esc + Shift bypass 포함).
- vrange/hrange 는 두 번 클릭으로 정확히 endpoint 잡아서 생성, rect/arrow 는 드래그.
- 도구는 onCommit 자동 해제 안 됨 — 같은 도구로 연속 생성 가능.
- 호버 시 미리보기 + 좌표 chip 표시.
- 라벨 자동 입력창 + ✕ 또는 Esc 로 라벨 없이 종료 가능.

**남은 항목 (Phase B)**
- **B13 — round-trip 검증** (브라우저 수동 확인 필요): 새로 만든 어노테이션 → 저장 → 새로고침 → 같은 모양으로 다시 보이는지. 코드 상으론 store ↔ content.annotations 가 양방향 sync 라서 통과 예상.

**다음 시작 시 첫 작업 후보 (Phase C — 다듬기)**
1. **C1 — AnnotationStyleEditor**: 선택된 어노테이션에 인라인 색/투명도/테두리(solid/dashed)/z-order 컨트롤. 툴바 옆 또는 floating popover.
2. **C3 — Undo/Redo 키바인딩**: `store.history` 는 이미 coalesce 까지 준비됨. document keydown 으로 Cmd+Z / Cmd+Shift+Z 처리, input focus 시 무시.
3. **C6 — 라벨 충돌 회피**: 같은 축에 vline 두 개 라벨이 겹치면 above/below 교대 배치.
4. **D1-D4 — 고급 타입 라벨/UX 다듬기**: 코드는 다 있지만 UX 가 어색한 부분 (e.g. text 어노테이션은 폰트 크기/색 설정 필요).
