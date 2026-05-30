import { apiClient, extractData } from './client'

const BASE = '/api/reports'

/**
 * Link 대상 picker 의 작성자 / 게시조직 옵션 카탈로그.
 * 응답: { authors: [{name, count}], mounts: [{slug, name, count}] }
 */
export async function listLinkableFacets() {
  const res = await apiClient.get(`${BASE}/linkable-facets`)
  return extractData(res)
}

/**
 * Link 대상 picker 의 후보 보고서 풀 — 시스템 전체 linkable.
 * actor 워크스페이스 밖 보고서도 검색되도록 listReports 와 별도 endpoint.
 */
export async function listLinkableReports() {
  const res = await apiClient.get(`${BASE}/linkable`)
  return extractData(res)
}

/**
 * 이 보고서의 outgoing + incoming link 를 한 번에 조회.
 *
 *   ReportLinkRead[]:
 *     {
 *       id, kind, note, direction: 'outgoing' | 'incoming',
 *       counterpart: { id, title, owner_name, report_date },
 *       created_at, created_by_name,
 *     }
 */
export async function listReportLinks(reportId) {
  const res = await apiClient.get(`${BASE}/${reportId}/links`)
  return extractData(res)
}

/**
 * 새 link 생성 — 보는 화면(reportId)과 toReportId 사이.
 *
 * direction:
 *   - 'outgoing' (기본) : 이 보고서 → 상대 (예: "후속")
 *   - 'incoming'        : 상대 → 이 보고서 (예: "선행")
 * 저장은 항상 단방향 한 row — direction 은 from/to 만 바꿔서 들어간다.
 */
export async function createReportLink(
  reportId,
  { toReportId, kind, note, direction = 'outgoing' } = {},
) {
  const body = { to_report_id: toReportId, kind, direction }
  if (note) body.note = note
  const res = await apiClient.post(`${BASE}/${reportId}/links`, body)
  return extractData(res)
}

/**
 * Link 삭제 — link 의 *from* 보고서 편집권자만. 인커밍 쪽에서 함부로
 * 끊지 못하게 백엔드가 막는다.
 */
export async function deleteReportLink(reportId, linkId) {
  const res = await apiClient.delete(`${BASE}/${reportId}/links/${linkId}`)
  return extractData(res)
}

/**
 * 이 보고서를 중심으로 한 ±depth hop 관계도 (지식그래프 Phase 1a).
 *
 *   응답: {
 *     nodes: [{ id: "report:123", type: "report", report_id, title,
 *               owner_name, workspace_slug, report_type_id, report_date,
 *               degree, is_center }],
 *     edges: [{ source: "report:123", target: "report:456", kind }],
 *     truncated: boolean,
 *     center_id: "report:123",
 *   }
 *
 * id/source/target 는 react-force-graph 기본 accessor 와 같은 키라 그대로
 * 넘기면 된다.
 */
export async function getReportLinkGraph(
  reportId,
  { depth = 2, includeTags = false, tagAxes, tagMinDegree, includeComposites = false } = {},
) {
  // tag_axes 가 반복 키라 URLSearchParams 로 직접 만든다 (글로벌과 동일 컨벤션).
  const params = new URLSearchParams()
  params.append('depth', String(depth))
  if (includeTags) params.append('include_tags', 'true')
  for (const a of tagAxes ?? []) params.append('tag_axes', a)
  if (tagMinDegree) params.append('tag_min_degree', String(tagMinDegree))
  if (includeComposites) params.append('include_composites', 'true')
  const res = await apiClient.get(
    `${BASE}/${reportId}/link-graph?${params.toString()}`,
  )
  return extractData(res)
}

/**
 * 워크스페이스 범위의 글로벌 관계도 (지식그래프 Phase 1b).
 * 연결된 보고서만(고립 노드 제외) 그린다. 응답 shape 은 로컬과 동일하나
 * center_id 는 null.
 *
 *   @param {object}  opts
 *   @param {string=} opts.dateFrom  'YYYY-MM-DD'
 *   @param {string=} opts.dateTo    'YYYY-MM-DD'
 *   @param {number[]=} opts.typeIds   보고서 종류 id (OR)
 *   @param {string[]=} opts.kinds     link kind key (OR)
 *   @param {number[]=} opts.entityIds 관련정보 entity id (axis 별 AND)
 *   @param {boolean=}  opts.includeTags    관련정보(entity) 레이어 포함
 *   @param {string[]=} opts.tagAxes        레이어로 그릴 축(slug) — 빈/없으면 전체
 *   @param {number=}   opts.tagMinDegree   N개 이상 보고서가 공유한 태그만 (2=공유만)
 *   @param {number=}  opts.limit
 */
export async function getGlobalLinkGraph({
  dateFrom,
  dateTo,
  typeIds,
  kinds,
  entityIds,
  includeTags = false,
  tagAxes,
  tagMinDegree,
  includeComposites = false,
  includeIsolated = false,
  limit,
} = {}) {
  // FastAPI 의 list[…] Query 는 반복 키(types=1&types=2, 대괄호 없음)를
  // 기대한다. axios 기본 직렬화는 types[]=.. 라서 URLSearchParams.append
  // 로 직접 만든다 (modules/reports/api.js 와 동일 컨벤션).
  const params = new URLSearchParams()
  if (dateFrom) params.append('date_from', dateFrom)
  if (dateTo) params.append('date_to', dateTo)
  for (const id of typeIds ?? []) params.append('types', String(id))
  for (const k of kinds ?? []) params.append('kinds', k)
  for (const id of entityIds ?? []) params.append('entities', String(id))
  if (includeTags) params.append('include_tags', 'true')
  for (const a of tagAxes ?? []) params.append('tag_axes', a)
  if (tagMinDegree) params.append('tag_min_degree', String(tagMinDegree))
  if (includeComposites) params.append('include_composites', 'true')
  if (includeIsolated) params.append('include_isolated', 'true')
  if (limit) params.append('limit', String(limit))
  const qs = params.toString()
  const res = await apiClient.get(
    qs ? `${BASE}/link-graph?${qs}` : `${BASE}/link-graph`,
  )
  return extractData(res)
}
