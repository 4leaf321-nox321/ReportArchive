import { apiClient, extractData } from './client'

const TYPES_BASE = '/api/entity-types'
const BASE = '/api/entities'

/**
 * List the axes (모델 / 부품 / BOM / 단계 / 불량 / 시험 / 시뮬레이션 등).
 * 시드된 7개 + admin 이 직접 추가한 것까지 포함. 세션 동안 큰 변동은
 * 없지만 admin 페이지에서 축을 추가하면 즉시 다시 받아야 한다.
 *
 *   { items: EntityTypeRead[] }
 */
export async function listEntityTypes() {
  const res = await apiClient.get(TYPES_BASE)
  return extractData(res)
}

/**
 * Admin-only — add a new axis. `sortOrder` 생략 시 백엔드가 max+1 로
 * 채워 새 축이 탭 strip 의 가장 오른쪽에 붙는다.
 */
export async function createEntityType({
  slug,
  label,
  icon = '',
  multi = true,
  sortOrder,
  description = '',
} = {}) {
  const body = { slug, label, icon, multi, description }
  if (sortOrder !== undefined) body.sort_order = sortOrder
  const res = await apiClient.post(TYPES_BASE, body)
  return extractData(res)
}

/**
 * Admin-only — delete an axis. 백엔드가 값이 등록돼 있으면 400 으로 거절
 * 하므로 호출 전에 값 개수를 0 으로 만들어두어야 한다 (개별 값 삭제 또는
 * 다른 축으로 머지).
 */
export async function deleteEntityType(id) {
  const res = await apiClient.delete(`${TYPES_BASE}/${id}`)
  return extractData(res)
}

/**
 * Picker list of entity values. Defaults to active-only; admin pages
 * pass `includeDeprecated=true` to see the full set.
 *
 *   { items: EntityRead[] }
 *
 * `typeId` filters to one axis (the picker's normal usage); omitting
 * it returns across all axes (mostly useful for global search later).
 */
export async function listEntities({
  typeId,
  q,
  includeDeprecated = false,
  limit = 200,
  withUsage = false,
} = {}) {
  const params = { limit }
  if (typeId != null) params.type_id = typeId
  if (q && q.trim()) params.q = q.trim()
  if (includeDeprecated) params.include_deprecated = true
  if (withUsage) params.with_usage = true
  const res = await apiClient.get(BASE, { params })
  return extractData(res)
}

/**
 * Create a new entity value within an axis. Any authenticated user can
 * call this — the server collapses case-insensitive duplicates to the
 * existing canonical row, so the picker's "+ 새로 추가" can fire
 * optimistically without a pre-check.
 */
export async function createEntity({ type_id, value, code, description = '' } = {}) {
  const body = { type_id, value, description }
  if (code !== undefined) body.code = code
  const res = await apiClient.post(BASE, body)
  return extractData(res)
}

/** Admin-only: rename / restamp / deprecate / restore. */
export async function updateEntity(id, { value, code, description, status } = {}) {
  const body = {}
  if (value !== undefined) body.value = value
  if (code !== undefined) body.code = code
  if (description !== undefined) body.description = description
  if (status !== undefined) body.status = status
  const res = await apiClient.patch(`${BASE}/${id}`, body)
  return extractData(res)
}

/** Admin-only: re-link every report tagged with `id` to `intoId`, then drop the source. */
export async function mergeEntity(id, intoId) {
  const res = await apiClient.post(`${BASE}/${id}/merge`, { into_id: intoId })
  return extractData(res)
}

/**
 * Admin-only — slim list of reports currently tagged with this entity.
 * Workspace-agnostic by design so the admin dialogs always show every
 * blocker, regardless of the admin's active workspace. Used by:
 *   - the row's "사용 N건" cell popover
 *   - the delete dialog (to list blockers + disable when N > 0)
 *   - the merge dialog (to preview which reports will be re-linked)
 *
 *   { items: [{ id, title, workspace_slug, updated_at }] }
 */
export async function listEntityUsage(id) {
  const res = await apiClient.get(`${BASE}/${id}/usage`)
  return extractData(res)
}

/**
 * Admin-only — drop the link between this entity and one specific
 * report. The entity row itself stays. Idempotent: removing a link
 * that doesn't exist returns success.
 */
export async function unlinkEntityFromReport(entityId, reportId) {
  const res = await apiClient.delete(`${BASE}/${entityId}/usage/${reportId}`)
  return extractData(res)
}

/**
 * Admin-only — drop every link this entity has across all reports.
 * After this the entity has 0 usage and can be hard-deleted; the
 * entity itself stays unless the admin explicitly deletes it next.
 */
export async function unlinkEntityFromAllReports(entityId) {
  const res = await apiClient.delete(`${BASE}/${entityId}/usage`)
  return extractData(res)
}

/** Admin-only hard delete. Server returns 400 when the entity is still in use. */
export async function deleteEntity(id) {
  const res = await apiClient.delete(`${BASE}/${id}`)
  return extractData(res)
}
