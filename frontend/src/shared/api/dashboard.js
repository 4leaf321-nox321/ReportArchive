import { apiClient, extractData } from './client'

/**
 * 부서 대시보드 집계 (Phase 3A) — 서버가 KPI·단계·추세·건강도·엔티티·작성자Top
 * 을 한 번에 계산해 돌려준다. 부서 컨텍스트는 X-Workspace-Slug 헤더로 잡힌다.
 *
 * @param {{from?: string, to?: string, unit?: 'week'|'month'}} opts
 *   from/to 는 'YYYY-MM-DD'(생략 시 전체 기간). unit 은 추세 버킷 단위.
 * 반환: { kpis, phase_breakdown, trend, health, entity_coverage, author_top, content_metrics }
 */
export async function getDashboard({ from, to, unit = 'week', includeDescendants } = {}) {
  const params = new URLSearchParams()
  if (from) params.append('from', from)
  if (to) params.append('to', to)
  if (unit) params.append('unit', unit)
  if (includeDescendants) params.append('include_descendants', 'true')
  const res = await apiClient.get(`/api/dashboard?${params.toString()}`)
  return extractData(res)
}

/**
 * 두 메타데이터 차원의 교차표. row/col 은 차원 키(entity:<slug> | report_type | template).
 * 반환: { row_label, col_label, rows:[header], cols:[header], cells:{rowKey:{colKey:count}} }
 * header = { key, label, entity_id?, report_type_id?, template_id? }
 */
export async function getCrosstab({ row, col, from, to, includeDescendants } = {}) {
  const params = new URLSearchParams()
  params.append('row', row)
  params.append('col', col)
  if (from) params.append('from', from)
  if (to) params.append('to', to)
  if (includeDescendants) params.append('include_descendants', 'true')
  const res = await apiClient.get(`/api/dashboard/crosstab?${params.toString()}`)
  return extractData(res)
}
