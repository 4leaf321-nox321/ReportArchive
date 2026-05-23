/**
 * Per-widget AI-prompt example snippets. One entry per `### <type>`
 * section the prompt writes out. `types` is the list of widget types
 * each entry covers — a single section covers multiple types when
 * their handling is identical (e.g. image / attachment / cad_3d share
 * a single "don't generate these" warning).
 *
 * Used as the source of truth by:
 *   - WIDGET_EXAMPLES_TEXT   : the joined-text block prompts paste in
 *     via the {{widget_examples}} placeholder
 *   - PROMPT_COVERED_WIDGETS : the set the coverage sidebar checks
 *     (catalog ∖ covered → red "미등록" chips)
 *   - renderWidgetExampleBlock(type) : per-widget inline used by the
 *     {{widget:foo}} placeholder
 *
 * When the backend gains a new widget, add ONE entry here and both
 * the prompts + the "미등록" flag update together.
 */
export const WIDGET_PROMPT_EXAMPLES = [
  {
    types: ['heading'],
    body: [
      '### heading (제목)',
      'props (required: level) : `{ "level": 2 }`   // 1=대제목, 2=중제목, 3=소제목',
      'content : `{ "text": "섹션 제목" }`',
    ].join('\n'),
  },
  {
    types: ['rich_text'],
    body: [
      '### rich_text (자유 서술 / 마크다운)',
      'props : `{}`   // 모든 필드 선택. label 등 없음.',
      'content (권장: 단순형) : `{ "markdown": "여러 줄 텍스트…\\n- 글머리도 가능" }`',
      'content (구조형) : `{ "items": [ {"depth":0,"text":"첫째 줄"}, {"depth":1,"text":"하위 항목"} ] }`   // depth 는 0~5 정수',
    ].join('\n'),
  },
  {
    types: ['equation'],
    body: [
      '### equation (수식 — LaTeX)',
      'props (required: label) : `{ "label":"지배 방정식" }`',
      'content : `{ "latex":"\\\\sigma = \\\\frac{F}{A}", "display_mode":"display", "number":"(1)" }`',
      '- latex 은 KaTeX 호환 LaTeX 문자열. **JSON 안에 들어가므로 백슬래시는 두 번** (`\\\\frac`, `\\\\sigma`, `\\\\int_0^1` 등).',
      '- display_mode 는 `display`(중앙·큰 글씨, 기본) | `inline`(베이스라인 정렬, 본문 삽입용).',
      '- number (선택)는 우측에 표시되는 식 번호 — 예: `"(1)"`, `"(eq. 3.2)"`. 비우면 표시 안 됨.',
    ].join('\n'),
  },
  {
    types: ['key_value'],
    body: [
      '### key_value (키-값 카드 — 자유 입력)  ★ 자주 틀리는 형식 — 주의 ★',
      'props : `{ "label":"메모" }`   // items 는 선택 사항. 보고서마다 작성자가 직접 항목을 정의하는 위젯.',
      'content : `{ "items":[ {"key":"stress","label":"발생 응력","type":"number"}, {"key":"unit","label":"단위","type":"text"} ], "stress": 100, "unit": "MPa" }`',
      '- content.items 가 보고서별 항목 정의. 비어 있으면 props.items(있다면) 로 폴백.',
      '- 각 항목의 값은 item.key 그대로 top-level 키로 저장. `values` 같은 래퍼 절대 금지.',
      '- item.type 은 text | number | integer | date | select 중 하나. `multi: true` 항목의 값은 배열 (예: `"defect_type": ["크랙","변형"]`).',
      '- 키 슬러그는 영문 소문자 시작 + [a-z0-9_]. 예약 키(`caption`, `caption_skip_autofill`, `items`) 와 충돌 금지.',
    ].join('\n'),
  },
  {
    types: ['bulleted_list'],
    body: [
      '### bulleted_list (글머리 리스트)  ★ 자주 틀리는 형식 — 주의 ★',
      'props (required: label) : `{ "label": "후속 검토 사항" }`',
      'content : `{ "items": [ "첫째 항목", "둘째 항목", "셋째 항목" ] }`   // ← 문자열 배열. {text, depth} 객체 절대 금지.',
    ].join('\n'),
  },
  {
    types: ['table'],
    body: [
      '### table (표)',
      'props (required: label, columns) : `{ "label":"검토 내용", "columns":[ {"key":"category","label":"구분","type":"text"}, {"key":"amount","label":"금액","type":"number"} ] }`',
      'content : `{ "rows":[ {"category":"배경","amount":1200}, {"category":"결과","amount":3400} ] }`   // 행 객체의 키 = column.key',
    ].join('\n'),
  },
  {
    types: ['chart'],
    body: [
      '### chart (차트 — 카테고리 x축)',
      'props (required: label) : `{ "label":"월별 매출", "chart_type":"line", "x_column_key":"month", "columns":[ {"key":"month","label":"월","type":"text"}, {"key":"sales","label":"매출","type":"number"} ] }`',
      'content : `{ "rows":[ {"month":"1월","sales":120}, {"month":"2월","sales":135} ] }`',
      '※ x_column_key 가 가리키는 열 외에 모든 열은 type:"number" 여야 합니다.',
      '※ x 도 숫자라면 chart 대신 **scatter** 를 사용하세요 (산점도 / 곡선 / 회귀).',
    ].join('\n'),
  },
  {
    types: ['scatter'],
    body: [
      '### scatter (산점도 — x·y 모두 수치)',
      'props (required: label, mode, x_column_key, columns≥2) : `{ "label":"전압-전류 곡선", "mode":"scatter_line", "x_column_key":"voltage", "columns":[ {"key":"voltage","label":"전압(V)","type":"number"}, {"key":"current","label":"전류(A)","type":"number"} ] }`',
      'content : `{ "rows":[ {"voltage":0,"current":0}, {"voltage":1.0,"current":0.5}, {"voltage":2.0,"current":1.1} ] }`',
      '- chart 와 달리 x·y **모두 type:"number"**. category 가 섞이면 chart 위젯을 쓰세요.',
      '- mode 는 `scatter`(점만) | `line`(선만) | `scatter_line`(점 + 선).',
      '- 시리즈를 명시적으로 지정하려면 content 에 `"series":[ {"label":"측정","x_key":"voltage","y_key":"current"} ]`. 생략 시 x_column_key 외 모든 number 열이 자동 시리즈가 됩니다.',
      '- props 에 x_axis_title / y_axis_title (선택) 로 축 라벨, content 에 x_min/x_max/y_min/y_max (선택) 로 범위 고정 가능.',
    ].join('\n'),
  },
  {
    types: ['scatter3d'],
    body: [
      '### scatter3d (3D 산점도 — Plotly)',
      'props (required: label, columns≥3) : `{ "label":"파라미터 응답면", "columns":[ {"key":"p1","label":"P1","type":"number"}, {"key":"p2","label":"P2","type":"number"}, {"key":"resp","label":"응답","type":"number"} ] }`',
      'content : `{ "mode":"scatter3d", "series":[ {"label":"실험","kind":"scatter3d","x_key":"p1","y_key":"p2","z_key":"resp"} ], "rows":[ {"p1":0,"p2":0,"resp":1.2}, {"p1":0.5,"p2":0.3,"resp":2.4} ], "colorscale":"Viridis" }`',
      '- 모든 컬럼은 type:"number" (3D 좌표). 회전·확대·호버는 Plotly 기본 제공.',
      '- series.kind 는 `scatter3d`(마커 구름) | `surface`(long-form 데이터를 그리드로 pivot 한 응답면). 한 차트에 둘 다 섞어도 OK.',
      '- 4번째 컬럼을 더해 `"color_key":"<key>"` 를 series 에 추가하면 마커/표면을 그 값으로 색상 매핑.',
      '- colorscale 은 `Viridis | Plasma | Cividis | Hot | Blues | Reds | Greens | RdBu | Bluered | Portland | Jet` 중 하나 (위젯 전체에 1개).',
    ].join('\n'),
  },
  {
    types: ['heatmap'],
    body: [
      '### heatmap (히트맵 — 2D 매트릭스)',
      'props (required: label) : `{ "label":"민감도 분석", "x_axis_title":"파라미터", "y_axis_title":"사양" }`',
      'content : `{ "x_labels":["A","B","C"], "y_labels":["사양1","사양2"], "matrix":[[0.1,0.4,0.7],[0.3,0.6,0.9]], "colorscale":"Viridis" }`',
      '- 데이터는 (행, 열) 의 2-D 매트릭스 — chart/scatter 의 columns+rows 모델과 **다릅니다**.',
      '- matrix[i] 는 y_labels[i] 행. matrix[i][j] 는 (y_labels[i], x_labels[j]) 셀 값.',
      '- 길이 일치 필수: matrix.length === y_labels.length, matrix[*].length === x_labels.length.',
      '- 빈 셀은 `null` (sparse data 도 OK — Plotly 가 갭으로 표시). reverse_scale:true 로 색상 반전.',
      '- z_min / z_max (선택) 로 색축 범위 고정 — 여러 히트맵 비교 시 유용.',
      '- colorscale 은 scatter3d 와 동일 enum.',
    ].join('\n'),
  },
  {
    types: ['contour'],
    body: [
      '### contour (등고선 차트 — 2D 응답면)',
      'props (required: label) : `{ "label":"응답면", "x_axis_title":"X1", "y_axis_title":"X2" }`',
      '두 가지 입력 모드 — `content.mode` 가 `"matrix"`(기본) 또는 `"rows"`.',
      '',
      '**모드 1) matrix (그리드)** — heatmap 과 동일 데이터 모델:',
      'content : `{ "mode":"matrix", "x_labels":["1","2","3"], "y_labels":["1","2","3"], "matrix":[[0.1,0.4,0.7],[0.4,1.0,0.4],[0.7,0.4,0.1]], "colorscale":"Viridis", "ncontours":12 }`',
      '- 같은 길이 제약 — `matrix.length === y_labels.length`, `matrix[*].length === x_labels.length`.',
      '',
      '**모드 2) rows (x · y · z 행)** — 점 단위 입력:',
      'content : `{ "mode":"rows", "rows":[ {"x":0,"y":0,"z":0.1}, {"x":0,"y":1,"z":0.4}, {"x":1,"y":0,"z":0.4}, {"x":1,"y":1,"z":1.0} ], "colorscale":"Viridis", "ncontours":12 }`',
      '- 렌더러가 unique x · y 값을 축으로 잡고 sparse matrix 로 pivot. DOE / 측정 데이터처럼 자유 (x,y) 좌표에 값이 흩어진 경우에 적합.',
      '- 같은 (x, y) 쌍은 후행 z 가 덮어씁니다.',
      '',
      '공통 옵션 :',
      '- `ncontours` (선택, 기본 15) : 등고선 개수.',
      '- `contours_coloring` (선택) : `fill` (채우기 + 선) | `heatmap` (배경만, 선 없음) | `lines` (선만) | `none`.',
      '- `show_lines` (선택, 기본 true) / `show_labels` (선택, 기본 false) : 선과 값 라벨 표시.',
      '- `connect_gaps` (선택, 기본 true) : 빈 셀(null)을 인접 데이터로 메워 등고선이 끊기지 않게 — sparse / DOE 데이터를 매끄러운 응답면으로 그릴 때 유용. 빈 영역을 의도적으로 비워두려면 false.',
      '- colorscale, reverse_scale, z_min, z_max 는 heatmap 과 동일.',
      '- 평탄 surface (모든 값 동일 또는 null) 면 등고선이 그려지지 않고 빈 axes 만 보입니다.',
    ].join('\n'),
  },
  {
    types: ['treemap'],
    body: [
      '### treemap (트리맵 — 계층 면적 차트)',
      'props (required: label) : `{ "label":"비용 분해" }`',
      'content : `{ "rows":[ {"label":"전체","parent":"","value":null}, {"label":"재료","parent":"전체","value":30}, {"label":"가공","parent":"전체","value":20}, {"label":"검사","parent":"전체","value":10}, {"label":"기계가공","parent":"가공","value":12}, {"label":"열처리","parent":"가공","value":8} ], "text_info":"label+value+percent_parent", "branchvalues":"remainder", "colorscale":"Viridis" }`',
      '- 데이터는 long-form `rows` 배열. 각 row 는 `{label, parent, value, color?}`.',
      '- `parent` 는 다른 row 의 `label` 과 정확히 일치하거나, 루트면 `""` 빈 문자열.',
      '- `value` 는 숫자 (또는 null). `branchvalues:"remainder"` (기본) 이면 자식이 있는 row 의 value 는 자동으로 자식 합. `"total"` 이면 그대로 사용.',
      '- `text_info` 옵션: `"label"` | `"label+value"` | `"label+value+percent_parent"` (기본) | `"label+value+percent_root"` | `"label+percent_root"` | `"value"` | `"none"`.',
      '- `colorscale` (선택) — 설정 시 row 의 value 를 색에 매핑. 미설정 시 자동 — 최상위 그룹별 색상.',
      '- 각 row 의 `color` 필드(선택, hex/CSS) 는 해당 cell 색상을 강제 — colorscale 보다 우선.',
      '- `unit` (선택) — 셀 라벨과 호버에 값 옆에 붙는 단위 문자열 (예: "억원", "%", "건"). 빈 문자열이면 표시 안 함.',
      '- 비용 분해, 시장 점유, BoM, 항목별 비중 같은 계층 비중 시각화에 적합.',
    ].join('\n'),
  },
  {
    types: ['packing'],
    body: [
      '### packing (원형 패킹 — 원·원 계층 비중)',
      'props (required: label) : `{ "label":"비용 분해" }`',
      'content : `{ "rows":[ {"label":"전체","parent":"","value":null}, {"label":"재료","parent":"전체","value":30}, {"label":"가공","parent":"전체","value":20}, {"label":"기계가공","parent":"가공","value":12}, {"label":"열처리","parent":"가공","value":8} ], "text_info":"label+value+percent", "padding":4 }`',
      '- 데이터 모델은 treemap 과 동일 (`rows`, `parent`, `value`). 시각만 사각형 대신 중첩 원.',
      '- 자식이 있는 row 의 `value` 는 항상 자식 합으로 자동 계산 (입력값 무시).',
      '- `parent` 가 다른 row 의 `label` 과 일치 안 하면 자동으로 루트로 강등 — 데이터 일관성 유지.',
      '- `text_info` 옵션 : `"label"` | `"label+value"` | `"label+value+percent"` (기본) | `"value"` | `"none"`. 작은 원에는 라벨이 자동 생략.',
      '- `padding` (선택, 기본 4) : 형제 원 사이 픽셀 간격. 그룹 구분을 강조하려면 6~8 추천.',
      '- `colorscale` 미설정 시 최상위 그룹별 카테고리 색상. 설정 시 값을 색에 매핑.',
      '- 각 row `color` (선택, hex/CSS) 는 그 원 색을 강제 — colorscale / 그룹 색상보다 우선.',
      '- 비용 분해, BoM, 조직 인원 분포 같은 계층 비중 시각화에 적합 (treemap 의 원형 대안).',
    ].join('\n'),
  },
  {
    types: ['tree'],
    body: [
      '### tree (트리 다이어그램 — 노드·엣지 계층도)',
      'props (required: label) : `{ "label":"조직도" }`',
      'content : `{ "rows":[ {"label":"CEO","parent":""}, {"label":"CTO","parent":"CEO"}, {"label":"CFO","parent":"CEO"}, {"label":"개발팀","parent":"CTO","subtitle":"15명"}, {"label":"디자인팀","parent":"CTO","subtitle":"4명"} ], "orientation":"vertical", "node_shape":"rect", "edge_style":"curve" }`',
      '- 데이터 모델은 treemap / packing 과 동일 (`rows`, `parent`). 시각화만 노드-엣지 트리.',
      '- `parent` 가 다른 row 의 `label` 과 정확히 일치 안 하면 그 row 는 자동으로 루트로 강등.',
      '- `subtitle` (선택, 짧은 문자열) : 노드 아래 작은 부제 (역할명, 인원수 등).',
      '- `orientation` : `"vertical"` (기본, 루트 상단) | `"horizontal"` (루트 왼쪽). 폭이 좁고 깊이가 깊으면 horizontal 추천.',
      '- `node_shape` : `"rect"` (기본) | `"circle"`.',
      '- `edge_style` : `"curve"` (기본, 부드러운 베지어) | `"step"` (직각 꺾임, 조직도 클래식) | `"straight"` (직선).',
      '- `color_by_group` (선택, 기본 true) : 최상위 ancestor 별로 카테고리 팔레트. false 면 모든 노드 단일 색상.',
      '- 각 row `color` (선택, hex/CSS) — 그 노드 색 강제, 그룹 색상보다 우선.',
      '- 조직도, 결정 트리, 분류 체계, 의사결정 흐름 같은 계층 관계 시각화에 적합.',
    ].join('\n'),
  },
  {
    types: ['network'],
    body: [
      '### network (네트워크 그래프 — 노드·엣지 일반 그래프)',
      'props (required: label) : `{ "label":"의존성 그래프" }`',
      'content : `{ "nodes":[ {"id":"auth","label":"Auth","group":"core","value":10}, {"id":"api","label":"API","group":"core","value":18}, {"id":"db","label":"DB","group":"infra","value":14}, {"id":"web","label":"Web","group":"app","value":8}, {"id":"mobile","label":"Mobile","group":"app","value":6} ], "edges":[ {"source":"web","target":"api"}, {"source":"mobile","target":"api"}, {"source":"api","target":"auth"}, {"source":"api","target":"db","weight":2,"label":"read/write"} ], "directed":true, "layout":"force", "color_by_group":true, "node_size_by_value":true }`',
      '- tree / treemap / packing 과 달리 **계층 관계가 아닌 일반 그래프** (사이클·다중 경로 허용). 계층이면 tree 를 쓰세요.',
      '- `nodes[*].id` 는 영문/숫자/_ 권장, 페이지 내 고유. `edges[*].source` / `target` 는 노드 id 와 정확히 일치해야 함 (불일치 엣지는 자동 숨김).',
      '- 셀프 루프(source=target) 은 지원하지 않음 — 자동으로 숨겨집니다.',
      '- `label` (선택) : 노드 표시명. 비우면 id 가 표시됨.',
      '- `group` (선택) : `color_by_group` 시 같은 그룹 = 같은 색. `radial` 레이아웃은 그룹별로 동심원 ring.',
      '- `value` (선택, 숫자) : `node_size_by_value` 시 반경에 매핑.',
      '- 노드 `color` (선택, hex/CSS) : 해당 노드 색 강제 — 그룹 색상보다 우선.',
      '- 엣지 `weight` (선택) : forceLink 거리(클수록 짧음) + 선 굵기에 반영. `label` (선택) : `show_edge_labels:true` 일 때 표시. `directed` (선택, boolean) : 위젯 단위 `directed` 를 엣지별로 override.',
      '- `directed` (선택, 기본 false) : true 면 모든 엣지에 화살표.',
      '- `layout` : `"force"` (기본, 물리 시뮬레이션) | `"circular"` (원형) | `"grid"` (격자) | `"radial"` (그룹별 동심원).',
      '- `node_shape` : `"circle"` (기본) | `"rect"`.',
      '- `show_labels` (기본 true), `show_edge_labels` (기본 false).',
      '- `color_by_group` (기본 true), `node_size_by_value` (기본 true).',
      '- `node_size_min` / `node_size_max` (선택, 2~200) : 값별 크기 반경 범위 (기본 6 / 22).',
      '- `link_distance` (선택, 10~400, 기본 90) / `charge_strength` (선택, -2000~0, 기본 -400) : `force` 레이아웃 전용 노브.',
      '- 노드 좌표(`x`,`y`)는 사용자가 드래그/배치 후 자동 저장됨 — AI 가 생성할 때는 생략하세요 (시뮬레이션이 자동 배치).',
      '- 의존성 그래프, 인용 네트워크, 협업/소셜 네트워크, 시스템 컴포넌트 관계 시각화에 적합.',
    ].join('\n'),
  },
  {
    types: ['pie'],
    body: [
      '### pie (파이 / 도넛 차트 — 단일 계층 비중)',
      'props (required: label) : `{ "label":"비용 구성" }`',
      'content (파이) : `{ "rows":[ {"label":"재료","value":30}, {"label":"가공","value":20}, {"label":"검사","value":15} ], "text_info":"label+percent" }`',
      'content (도넛) : 위와 동일하되 `"chart_type":"donut", "hole":0.45` 추가. hole 은 0~0.9.',
      '- 데이터는 flat list — 계층이 있으면 treemap 을 쓰세요.',
      '- 음수/null/0 값 row 는 자동 제외.',
      '- `text_info` 옵션: `"label"` | `"label+percent"` (기본) | `"label+value"` | `"label+value+percent"` | `"percent"` | `"value"` | `"none"`.',
      '- `text_position` (선택, 기본 "auto") : `"auto"` | `"inside"` | `"outside"` | `"none"`.',
      '- `sort` (선택, 기본 true) : 큰 값부터 시계 방향. false 면 row 입력 순서대로.',
      '- `show_legend` (선택, 기본 true).',
      '- `unit` (선택) — 값 옆에 붙는 단위 (예: "억원", "건").',
      '- `colorscale` (선택) — 설정 시 value 를 색에 매핑. 미설정 시 카테고리 자동 팔레트.',
      '- row 의 `color` (선택, hex/CSS) 는 그 슬라이스 색을 강제 — colorscale 보다 우선.',
    ].join('\n'),
  },
  {
    types: ['waffle'],
    body: [
      '### waffle (와플 차트 — 격자 100칸 비중)',
      'props (required: label) : `{ "label":"시장 점유율" }`',
      'content : `{ "rows":[ {"label":"A","value":40}, {"label":"B","value":30}, {"label":"C","value":20}, {"label":"D","value":10} ], "cols":10, "grid_rows":10, "shape":"square", "fill_direction":"column", "show_legend":true, "unit":"%" }`',
      '- 격자는 `cols × grid_rows` 칸 (기본 10×10 = 100칸 = 1%/칸). row 의 `value` 합 대비 비율을 자동 계산해 largest-remainder 방식으로 셀에 배정 — 셀 합이 항상 정확히 cols×grid_rows.',
      '- `shape` : `"square"` (기본) | `"circle"`. 작은 격자는 원이 더 깔끔.',
      '- `fill_direction` : `"column"` (기본, 아래→위 / 왼→오 — 데이터가 막대처럼 쌓이는 느낌) | `"row"` (왼→오 / 위→아래, 텍스트 방향).',
      '- `show_legend` (선택, 기본 true) — 라벨/비중 범례.',
      '- `show_value_per_cell` (선택, 기본 false) — "1칸 ≈ N 단위" 안내 표시.',
      '- `unit` (선택) — 호버 값 옆 단위.',
      '- row 의 `color` (선택, hex/CSS) — 해당 그룹 셀 색 강제.',
      '- 시장 점유, 달성률, 인구 비중, 작은 % 항목 비교에 적합 (파이의 대안 — 작은 차이를 더 직관적으로 비교 가능).',
    ].join('\n'),
  },
  {
    types: ['box'],
    body: [
      '### box (박스플롯 — 그룹별 분포)',
      'props (required: label) : `{ "label":"케이스별 측정값" }`',
      'content : `{ "rows":[ {"group":"A","value":10}, {"group":"A","value":12}, {"group":"A","value":15}, {"group":"B","value":8}, {"group":"B","value":11}, {"group":"B","value":13} ], "orientation":"vertical", "box_points":"outliers", "box_mean":"line", "jitter":0.3, "unit":"mm" }`',
      '- 데이터는 long-form (`{group, value}`) — 같은 `group` 의 row 들이 한 박스로 묶여 Q1/median/Q3/whiskers/outliers 자동 계산. 사전 요약 통계 불필요.',
      '- `orientation` : `"vertical"` (값=Y, 기본) | `"horizontal"` (값=X). 그룹 이름이 길면 horizontal 이 가독성 좋음.',
      '- `box_points` : `"outliers"` (기본, 이상치만 점) | `"suspectedoutliers"` (3·IQR 강조) | `"all"` (모든 점) | `"none"` (점 없음).',
      '- `box_mean` : `"none"` (중앙값만, 기본) | `"line"` (평균 점선 추가) | `"sd"` (평균 + ±1σ 마커).',
      '- `jitter` (0~1, 기본 0.3) : 점 분산 정도 (`box_points` ≠ none 일 때만 의미). 0 = 일렬, 1 = 박스 폭 전체.',
      '- `y_min` / `y_max` (선택, 숫자 또는 null) : 값 축 (vertical → Y, horizontal → X) 수동 범위. 한쪽만 지정하면 그 쪽만 고정, 반대쪽은 자동.',
      '- `unit` (선택) — 호버 값 옆에 붙는 단위 (예: "mm", "kg", "%").',
      '- 그룹 순서는 row 입력 순서대로. 그룹 수가 많으면 카테고리 팔레트 자동 순환.',
      '- A/B 테스트, 실험 케이스 분산, 측정값 산포 같은 그룹별 분포 비교에 적합.',
    ].join('\n'),
  },
  {
    types: ['radar'],
    body: [
      '### radar (레이더 차트 — 다축 폴라 비교)',
      'props (required: label) : `{ "label":"제품 비교" }`',
      'content : `{ "axis_labels":["속도","효율","가격","유지보수","확장성"], "series":[ {"label":"A안"}, {"label":"B안"} ], "values":[[90,75],[80,85],[60,90],[70,80],[85,70]] }`',
      '- axis_labels 는 각 폴라 축 라벨 (3개 이상 권장).',
      '- series 의 color (선택) 는 hex/CSS 컬러; 미지정 시 회전 팔레트 자동 적용.',
      '- values 는 **`values[축_index][시리즈_index]`** 형식의 2D 배열. values.length === axis_labels.length, values[*].length === series.length.',
      '- value_min / value_max (선택) 로 반경 범위 고정. fill_opacity (0~1, 기본 0.3) 로 폴리곤 채움 강도.',
      '- 사양 비교 / 평가표 / 다요소 점수에 적합. 비교 항목이 1개면 bulleted_list 가 더 어울립니다.',
    ].join('\n'),
  },
  {
    types: ['milestone'],
    body: [
      '### milestone (마일스톤)',
      'props (required: label) : `{ "label":"프로젝트 일정" }`',
      'content : `{ "items":[ {"date":"2026-01-15","label":"기획","status":"done"}, {"date":"2026-03-01","label":"개발","status":"pending","note":"인력 보강 필요"} ] }`',
      'status 는 `pending` | `done` | `delayed` 셋 중 하나. (in_progress / planned 등 다른 값 사용 금지)',
    ].join('\n'),
  },
  {
    types: ['flowchart'],
    body: [
      '### flowchart (플로우차트)',
      'props (required: label) : `{ "label":"검토 흐름", "orientation":"horizontal" }`   // orientation: horizontal | vertical',
      'content : `{ "items":[ {"label":"요구사항"}, {"label":"설계"}, {"label":"검토","description":"리뷰 미팅"}, {"label":"승인"} ] }`',
      '※ 순차 흐름만 지원. `nodes` / `edges` 같은 키 사용 금지.',
    ].join('\n'),
  },
  {
    types: ['progress_bar'],
    body: [
      '### progress_bar (진행률 바)',
      'props (required: label) : `{ "label":"작업 진척도", "default_max":100, "unit":"%" }`   // default_max / unit 은 선택. 기본 100% 기준이면 둘 다 생략 가능',
      'content : `{ "items":[ {"label":"기획","value":100}, {"label":"개발","value":65}, {"label":"테스트","value":20,"max":40,"note":"케이스 부족"} ] }`',
      '- value 는 현재값(숫자), max 는 목표값(생략하면 props.default_max 사용). 비율(value/max) 에 따라 색상이 자동: <30% 빨강, 30–70% 주황, 70% 이상 초록, 100% 이상 진초록.',
      '- status(선택)는 `pending` | `in_progress` | `done` | `blocked` 중 하나. 지정하면 자동 색상보다 우선.',
      '- 단순 % 가 아닌 절대값 비교(예: "8 / 12 건")도 가능 — props.unit 을 "건" 등으로 바꾸고 item.max 를 명시.',
      '- 여러 작업·지표의 진척도를 한 번에 비교할 때 사용. 단일 KPI 면 key_value 가 더 어울립니다.',
    ].join('\n'),
  },
  {
    types: ['raci_matrix'],
    body: [
      '### raci_matrix (RACI 매트릭스)',
      'props (required: label) : `{ "label":"역할 분담" }`   // default_roles 는 선택 (보고서별로 content.roles 가 우선)',
      'content : `{ "roles":[ {"key":"modeling","label":"모델링"}, {"key":"analysis","label":"분석"}, {"key":"develop","label":"개발"}, {"key":"design","label":"설계"} ], "rows":[ {"label":"요구사항 정의","assignments":{"modeling":"I","analysis":"R/A","develop":"C","design":"C"}}, {"label":"시스템 모델링","assignments":{"modeling":"R/A","analysis":"C","develop":"I","design":"C"}}, {"label":"구현","assignments":{"modeling":"I","analysis":"I","develop":"R/A","design":"C"}} ] }`',
      '- roles 는 content 안에 둡니다 (props 가 아님). key 는 영문 소문자/숫자/_ 만, 페이지 내에서 고유.',
      '- role 의 `group` (선택)은 상단 헤더 그룹 라벨. 같은 group 의 **인접한** 역할들이 자동으로 한 셀로 병합 (colspan).',
      '- assignments 의 키는 content.roles 의 key 와 정확히 일치해야 함. 알 수 없는 키 사용 금지.',
      '- 셀 값은 `R`(실무) | `A`(책임) | `C`(자문) | `I`(공유) 중 하나 또는 `/` 로 결합 (예: `R/A`). 스키마 값은 영문자, 화면 표시는 자동으로 한국어("실무 / 책임")로 변환됩니다.',
      '- R = 실무(실제 작업), A = 책임(최종 책임자, 한 행에 1명), C = 자문(의견 제공), I = 공유(결과 통지).',
      '- 표준: 한 행에 A 는 1명만 (책임자 단일화). R 은 여러 명 가능. C/I 는 자유.',
    ].join('\n'),
  },
  {
    types: ['image', 'attachment', 'cad_3d', 'html_embed', 'video'],
    body: [
      '### image / attachment / cad_3d / html_embed / video  ★ AI 가 만들지 마세요 ★',
      '다섯 위젯 모두 content 가 시스템에 업로드된 파일의 `file_id` 를 요구합니다. AI 는 file_id 를 알 수 없으므로 이 위젯들은 `extra_blocks` / `content` 양쪽 모두에서 생성하지 마세요. 이미지·첨부·3D 모델·HTML 임베드·동영상이 필요하다는 점만 본문 rich_text 에 메모해 두세요. (사용자가 보고서를 받은 뒤 직접 추가합니다.)',
    ].join('\n'),
  },
]

export const WIDGET_EXAMPLES_TEXT = [
  '※ 모든 예시는 백엔드 스키마와 1:1 로 일치합니다. 키 이름·타입을 절대 변형하지 마세요.',
  ...WIDGET_PROMPT_EXAMPLES.map((e) => e.body),
].join('\n\n')

/** Set of widget `type` strings that have at least one example block. */
export const PROMPT_COVERED_WIDGETS = new Set(
  WIDGET_PROMPT_EXAMPLES.flatMap((e) => e.types),
)

// Index by single widget type → example body, so {{widget:foo}} can
// pull the exact section in O(1). Multi-type entries register the same
// body under each type they cover.
const _BY_TYPE = (() => {
  const map = new Map()
  for (const entry of WIDGET_PROMPT_EXAMPLES) {
    for (const t of entry.types) map.set(t, entry.body)
  }
  return map
})()

/** Body text for a single widget type, or `null` if no example exists.
 *  Caller decides how to surface the gap (e.g. inline a fallback string,
 *  or warn the user). */
export function getWidgetExampleBody(type) {
  return _BY_TYPE.get(type) ?? null
}
