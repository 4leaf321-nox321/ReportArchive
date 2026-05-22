import { apiClient, extractData } from './client'

const BASE = '/api/voc'

/**
 * Server-paginated VOC list. Returns
 *   { items: VocPostRead[], total: number, limit: number, offset: number }
 *
 * The list page fetches one page (default 200) at a time and virtualizes
 * within it; when the user scrolls near the loaded tail, it fetches the
 * next offset and appends. Filters reset the accumulator.
 */
export async function listVocPosts({
  status,
  category,
  mine,
  limit = 200,
  offset = 0,
} = {}) {
  const res = await apiClient.get(BASE, {
    params: {
      ...(status ? { status } : {}),
      ...(category ? { category } : {}),
      ...(mine ? { mine: true } : {}),
      limit,
      offset,
    },
  })
  return extractData(res)
}

export async function getVocPost(id) {
  const res = await apiClient.get(`${BASE}/${id}`)
  return extractData(res)
}

export async function createVocPost({
  title,
  body,
  category,
  attachments = [],
  workspaceSlug,
}) {
  const res = await apiClient.post(BASE, {
    title,
    body,
    category,
    attachments,
    workspace_slug: workspaceSlug ?? null,
  })
  return extractData(res)
}

export async function updateVocPost(id, patch) {
  // Only the editor's fields go through this — status / priority have
  // their own admin-only endpoints below.
  const payload = {}
  if (patch.title !== undefined) payload.title = patch.title
  if (patch.body !== undefined) payload.body = patch.body
  if (patch.category !== undefined) payload.category = patch.category
  if (patch.attachments !== undefined) payload.attachments = patch.attachments
  const res = await apiClient.patch(`${BASE}/${id}`, payload)
  return extractData(res)
}

export async function deleteVocPost(id) {
  const res = await apiClient.delete(`${BASE}/${id}`)
  return extractData(res)
}

export async function setVocStatus(id, statusValue) {
  const res = await apiClient.patch(`${BASE}/${id}/status`, { status: statusValue })
  return extractData(res)
}

export async function setVocPriority(id, priorityValue) {
  const res = await apiClient.patch(`${BASE}/${id}/priority`, { priority: priorityValue })
  return extractData(res)
}

export async function addVocComment(postId, body) {
  const res = await apiClient.post(`${BASE}/${postId}/comments`, { body })
  return extractData(res)
}

export async function updateVocComment(commentId, body) {
  const res = await apiClient.patch(`${BASE}/comments/${commentId}`, { body })
  return extractData(res)
}

export async function deleteVocComment(commentId) {
  const res = await apiClient.delete(`${BASE}/comments/${commentId}`)
  return extractData(res)
}
