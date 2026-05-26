import { apiClient, extractData } from './client'

export async function listThreadsForReport(reportId) {
  const res = await apiClient.get(`/api/reports/${reportId}/threads`)
  const data = extractData(res)
  return data?.items ?? []
}

export async function createThread(reportId, { pageIndex, blockId, body }) {
  const res = await apiClient.post(`/api/reports/${reportId}/threads`, {
    page_index: pageIndex,
    block_id: blockId,
    body,
  })
  return extractData(res)
}

export async function replyToThread(threadId, body) {
  const res = await apiClient.post(`/api/threads/${threadId}/comments`, {
    body,
  })
  return extractData(res)
}

/** Toggle thread status: 'resolved' | 'open' */
export async function setThreadStatus(threadId, status) {
  const res = await apiClient.patch(`/api/threads/${threadId}`, { status })
  return extractData(res)
}

export async function editComment(commentId, body) {
  const res = await apiClient.patch(`/api/comments/${commentId}`, { body })
  return extractData(res)
}

export async function deleteComment(commentId) {
  const res = await apiClient.delete(`/api/comments/${commentId}`)
  return extractData(res)
}

/**
 * Personal inbox — threads on reports the current user owns. Returns
 * { items, open_count }. Status: 'open' (default) | 'all'. `beforeId`
 * paginates by passing the smallest thread_id from the previous page.
 */
export async function listCommentsInbox({
  status = 'open',
  limit = 50,
  beforeId,
} = {}) {
  const params = { status, limit }
  if (beforeId != null) params.before_id = beforeId
  const res = await apiClient.get('/api/comments/inbox', { params })
  const data = extractData(res)
  return {
    items: data?.items ?? [],
    openCount: data?.open_count ?? 0,
  }
}
