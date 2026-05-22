import { apiClient, extractData } from './client'

const BASE = '/api/report-types'

/**
 * List report types visible to the current user (official + own
 * unofficial). Admins see everything.
 *
 *   { items: ReportTypeRead[] }
 *
 * Use `q` for live filtering inside the picker — substring match on
 * name + description, case-insensitive.
 */
export async function listReportTypes({ q, limit = 200 } = {}) {
  const params = { limit }
  if (q && q.trim()) params.q = q.trim()
  const res = await apiClient.get(BASE, { params })
  return extractData(res)
}

/** Admin-only — full list, including every user's unofficial entries. */
export async function listAllReportTypes({ q, limit = 500 } = {}) {
  const params = { limit }
  if (q && q.trim()) params.q = q.trim()
  const res = await apiClient.get(`${BASE}/all`, { params })
  return extractData(res)
}

/**
 * Create a new report type. Non-admin callers always land as
 * `unofficial`; the optional `status` is honored only when the
 * caller is admin. The server is idempotent on case-insensitive name
 * — sending an existing name returns that row instead of erroring.
 */
export async function createReportType({ name, description = '', status } = {}) {
  const body = { name, description }
  if (status) body.status = status
  const res = await apiClient.post(BASE, body)
  return extractData(res)
}

export async function updateReportType(id, { name, description } = {}) {
  const body = {}
  if (name !== undefined) body.name = name
  if (description !== undefined) body.description = description
  const res = await apiClient.patch(`${BASE}/${id}`, body)
  return extractData(res)
}

export async function promoteReportType(id) {
  const res = await apiClient.post(`${BASE}/${id}/promote`)
  return extractData(res)
}

export async function demoteReportType(id) {
  const res = await apiClient.post(`${BASE}/${id}/demote`)
  return extractData(res)
}

export async function deleteReportType(id) {
  const res = await apiClient.delete(`${BASE}/${id}`)
  return extractData(res)
}
