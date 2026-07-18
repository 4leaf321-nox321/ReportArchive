// 보고서 위젯 레이아웃 — 에디터(ReportDetailPage)와 읽기전용 렌더(InlineReportView)가
// 위젯의 세로 크기/auto-fit 판정을 일치시키기 위한 공유 상수·헬퍼.
//
// ⚠ 진실의 원천은 ReportDetailPage.jsx 다(REPORT_ROW_HEIGHT / WIDGETS_DEFAULT_NO_AUTOFIT
//   / autoFitForBlock). 분할 보기에서 좌(에디터)·우(InlineReportView)의 차트·트리맵
//   높이가 달라 보이던 문제를 없애려 그 로직을 여기로 추출해 양쪽이 공유한다. 에디터
//   값이 바뀌면 여기도 같이 바꿔야 한다(두 정의가 어긋나면 높이가 다시 벌어진다).

// RGL 격자 한 행(row)의 픽셀 높이. 위젯 픽셀 높이 = row_span*ROW_HEIGHT +
// (row_span-1)*세로갭(보고서별 page_gap_px). 갭은 호출부가 넘긴다.
export const REPORT_ROW_HEIGHT = 8

// auto_fit 기본 OFF(수동 셀 크기) 위젯들 — 차트/스캐터/히트맵/트리맵 등. content 로
// 높이를 몰면 데이터 편집 중 매번 작게 스냅돼 깨져 보여 고정 높이를 쓴다. html_embed
// 은 부모에서 intrinsic height 측정이 불가해 항상 false(autoFitForBlock 에서 처리).
export const WIDGETS_DEFAULT_NO_AUTOFIT = new Set([
  'chart',
  'scatter',
  'scatter3d',
  'heatmap',
  'contour',
  'treemap',
  'packing',
  'tree',
  'network',
  'mind_map',
  'pie',
  'waffle',
  'box',
  'density',
  'radar',
  'sankey',
  'quadrant',
  'cad_3d',
  'html_embed',
  // 카드 — 나란히 놓인 카드들의 높이가 내용 길이에 따라 들쭉날쭉해지면 타일
  // 레이아웃이 무너진다. 작성자가 정한 셀 높이를 그대로 지켜 줄을 맞춘다.
  'card',
])

// 블록이 auto_fit(내용에 맞춰 높이) 모드인지. 저장된 layout.auto_fit 이 우선,
// 없으면 타입별 기본. html_embed 는 무조건 false.
export function autoFitForBlock(block, layout) {
  if (block?.type === 'html_embed') return false
  if (layout && Object.prototype.hasOwnProperty.call(layout, 'auto_fit')) {
    return layout.auto_fit !== false
  }
  return !WIDGETS_DEFAULT_NO_AUTOFIT.has(block?.type)
}

// 비-auto_fit 위젯의 고정 픽셀 높이(에디터 RGL 과 동일 공식). rowSpan 이 없으면 null.
export function fixedBlockHeightPx(rowSpan, rowGapPx) {
  if (!Number.isFinite(rowSpan) || rowSpan <= 0) return null
  const gap = Number.isFinite(rowGapPx) ? rowGapPx : 0
  return rowSpan * REPORT_ROW_HEIGHT + (rowSpan - 1) * gap
}
