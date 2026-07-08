// 위젯 "서식만" 복사/붙여넣기 — 위젯 종류별로 "서식(스타일)" 키만 화이트리스트로
// 골라낸다. 데이터(rows/text/files/values…)는 절대 포함하지 않는다. 복사·붙여넣기는
// "같은 종류" 끼리만이라, 소스에 존재하는 서식 키는 대상 스키마에도 유효하다.
//
// 서식은 두 곳에 흩어져 있다:
//   - props_overrides[blockId]:  text_style(공유), depth_styles, 일부 축 제목 등
//   - content[blockId]:          chart_type·축·min/max·colorscale·bordered 등 시각 옵션
//
// 모든 종류에 공통으로 캡션/노트 색 토큰(caption_color/note_color)은 서식으로 본다
// (텍스트·*_html 은 데이터라 제외). 표/비교표의 cell_styles·cell_html·header·merges
// 는 "행::열" 키라 다른 표로 못 옮기므로 제외(표는 표-레벨 서식만).

// content 쪽 공통 서식(있을 때만 복사) — 캡션/노트 색 토큰.
const COMMON_CONTENT = ['caption_color', 'note_color']

// 종류별 { props: [...], content: [...] }. 여기 없는 종류는 DEFAULT 적용.
const WIDGET_FORMAT_FIELDS = {
  heading: { props: ['text_style', 'level', 'margin_bottom_px'], content: [] },
  rich_text: { props: ['text_style', 'depth_styles'], content: [] },
  key_value: { props: ['text_style'], content: [] },
  bulleted_list: { props: ['text_style'], content: [] },
  // 표/비교표: 표-레벨 서식만(셀 단위 cell_styles/cell_html/header/merges 제외).
  // column_widths 는 추출은 하되, 붙여넣을 때 대상의 열 key 로 교집합 필터한다.
  table: {
    props: ['text_style'],
    content: [
      'bordered',
      'border_width',
      'border_color',
      'table_width_px',
      'expanded',
      'column_widths',
    ],
  },
  comparison: {
    props: ['text_style', 'max_cases', 'image_max_height_px', 'horizontal_scroll'],
    content: [
      'bordered',
      'border_width',
      'border_color',
      'table_width_px',
      'expanded',
      'row_label_width',
      'column_widths',
      'image_widths',
    ],
  },
  image: { props: [], content: ['aspect_ratio'] },
  chart: {
    props: [],
    content: ['chart_type', 'x_axis_title', 'y_axis_title', 'x_min', 'x_max', 'y_min', 'y_max'],
  },
  scatter: {
    props: [],
    content: ['mode', 'x_axis_title', 'y_axis_title', 'x_min', 'x_max', 'y_min', 'y_max'],
  },
  scatter3d: {
    props: ['x_axis_title', 'y_axis_title', 'z_axis_title'],
    content: ['mode', 'colorscale', 'reverse_scale', 'x_min', 'x_max', 'y_min', 'y_max'],
  },
  heatmap: {
    props: [],
    content: ['colorscale', 'reverse_scale', 'z_min', 'z_max', 'x_axis_title', 'y_axis_title', 'show_values'],
  },
  contour: {
    props: [],
    content: [
      'colorscale',
      'reverse_scale',
      'z_min',
      'z_max',
      'x_axis_title',
      'y_axis_title',
      'ncontours',
      'contours_coloring',
      'show_lines',
      'show_labels',
      'connect_gaps',
    ],
  },
  treemap: { props: [], content: ['colorscale', 'reverse_scale', 'text_info', 'branchvalues', 'unit'] },
  packing: { props: [], content: ['colorscale', 'reverse_scale', 'text_info', 'padding', 'unit'] },
  pie: {
    props: [],
    content: ['chart_type', 'hole', 'colorscale', 'reverse_scale', 'text_info', 'text_position', 'sort', 'show_legend', 'unit'],
  },
  waffle: {
    props: [],
    content: ['cols', 'grid_rows', 'shape', 'fill_direction', 'show_legend', 'show_value_per_cell', 'unit'],
  },
  box: {
    props: [],
    content: ['orientation', 'y_min', 'y_max', 'box_points', 'box_mean', 'jitter', 'unit', 'x_axis_title', 'y_axis_title'],
  },
  density: {
    props: [],
    content: ['bandwidth_mode', 'bandwidth', 'samples', 'x_min', 'x_max', 'fill', 'show_dots', 'dot_opacity', 'unit', 'x_axis_title', 'y_axis_title'],
  },
  tree: {
    props: [],
    content: ['orientation', 'node_shape', 'edge_style', 'color_by_group', 'node_padding_x', 'node_padding_y'],
  },
  video: { props: [], content: ['autoplay', 'loop', 'muted'] },
  html_embed: { props: [], content: ['display', 'height_px'] },
  flowchart: { props: ['text_style', 'orientation'], content: [] },
  milestone: { props: ['text_style'], content: [] },
  progress_bar: { props: ['text_style', 'default_max', 'unit'], content: [] },
  raci_matrix: { props: ['text_style'], content: [] },
}

// 매핑 없는 종류 — text_style(있으면) + 공통 색 토큰만. 데이터 키는 절대 없음.
const DEFAULT_FIELDS = { props: ['text_style'], content: [] }

function fieldsFor(type) {
  const e = WIDGET_FORMAT_FIELDS[type] ?? DEFAULT_FIELDS
  return { props: e.props, content: [...e.content, ...COMMON_CONTENT] }
}

function pick(obj, keys) {
  const out = {}
  if (!obj) return out
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k]
  }
  return out
}

/**
 * effectiveProps(= 템플릿 props + props_overrides 병합) 와 content 에서 그 종류의
 * "서식" 키만 추출. content/data 는 포함하지 않는다.
 * @returns {{ propsPatch: object, contentPatch: object }}
 */
export function extractWidgetFormat(type, effectiveProps, content) {
  const f = fieldsFor(type)
  return {
    propsPatch: pick(effectiveProps, f.props),
    contentPatch: pick(content, f.content),
  }
}

/** 복사된 서식에 의미있는 키가 하나라도 있는지(빈 서식은 토스트로 막기 위함). */
export function hasAnyFormat(fmt) {
  if (!fmt) return false
  const np = Object.keys(fmt.propsPatch ?? {}).length
  const nc = Object.keys(fmt.contentPatch ?? {}).length
  return np + nc > 0
}
