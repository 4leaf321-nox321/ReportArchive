import { apiClient, extractData } from './client'

const TYPES_BASE = '/api/entity-types'
const BASE = '/api/entities'

/**
 * List the 7 axes (model / part / bom / phase / defect / rel_test /
 * sim_type). Stable system data — safe to cache for the session.
 *
 *   { items: EntityTypeRead[] }
 */
export async function listEntityTypes() {
  const res = await apiClient.get(TYPES_BASE)
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

/** Admin-only hard delete. Server returns 400 when the entity is still in use. */
export async function deleteEntity(id) {
  const res = await apiClient.delete(`${BASE}/${id}`)
  return extractData(res)
}
