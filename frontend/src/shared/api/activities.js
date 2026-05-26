import { apiClient, extractData } from './client'

/** Returns `{ items }`. Cursor pagination via `beforeId`. */
export async function listActivities(reportId, { limit = 50, beforeId } = {}) {
  const params = new URLSearchParams()
  if (limit) params.append('limit', String(limit))
  if (beforeId) params.append('before_id', String(beforeId))
  const qs = params.toString()
  const url = `/api/reports/${reportId}/activities${qs ? `?${qs}` : ''}`
  const res = await apiClient.get(url)
  const data = extractData(res)
  return data?.items ?? []
}
