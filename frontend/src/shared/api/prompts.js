import { apiClient, extractData } from './client'

const BASE = '/api/prompts'

/**
 * List prompts visible to the current user (official + own
 * unofficial). Admins see everything.
 *
 *   { items: PromptRead[] }
 *
 * Each row carries server-computed `derived_widget_types` + `wildcard_all`
 * fields so the picker can render coverage chips without re-parsing the
 * body on every render.
 */
export async function listPrompts({ q, limit = 200 } = {}) {
  const params = { limit }
  if (q && q.trim()) params.q = q.trim()
  const res = await apiClient.get(BASE, { params })
  return extractData(res)
}

/** Admin-only — full list, including every user's unofficial entries. */
export async function listAllPrompts({ q, limit = 500 } = {}) {
  const params = { limit }
  if (q && q.trim()) params.q = q.trim()
  const res = await apiClient.get(`${BASE}/all`, { params })
  return extractData(res)
}

/** Single-row fetch — used by the picker preview when opening a prompt. */
export async function getPrompt(id) {
  const res = await apiClient.get(`${BASE}/${id}`)
  return extractData(res)
}

/**
 * Create a new prompt. Non-admin callers always land as `unofficial`;
 * the optional `status` is honored only for admin callers. The server
 * is idempotent on case-insensitive name — sending an existing name
 * returns that row instead of erroring.
 */
export async function createPrompt({
  name,
  description = '',
  body = '',
  settings = {},
  status,
} = {}) {
  const payload = { name, description, body, settings }
  if (status) payload.status = status
  const res = await apiClient.post(BASE, payload)
  return extractData(res)
}

export async function updatePrompt(
  id,
  { name, description, body, settings } = {},
) {
  const payload = {}
  if (name !== undefined) payload.name = name
  if (description !== undefined) payload.description = description
  if (body !== undefined) payload.body = body
  if (settings !== undefined) payload.settings = settings
  const res = await apiClient.patch(`${BASE}/${id}`, payload)
  return extractData(res)
}

export async function promotePrompt(id) {
  const res = await apiClient.post(`${BASE}/${id}/promote`)
  return extractData(res)
}

export async function demotePrompt(id) {
  const res = await apiClient.post(`${BASE}/${id}/demote`)
  return extractData(res)
}

export async function deletePrompt(id) {
  const res = await apiClient.delete(`${BASE}/${id}`)
  return extractData(res)
}
