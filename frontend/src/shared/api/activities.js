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

/**
 * 부서 활동 피드 — 현재 부서(X-Workspace-Slug 헤더 컨텍스트)에 게시/소유된
 * 보고서들의 최근 사건을 최신순으로. 각 항목은 report_title 을 포함해
 * 보고서별 타임라인과 달리 어디서 일어난 일인지 보여줄 수 있다.
 * 반환: [{ id, report_id, report_title, actor, type, payload, created_at }]
 */
export async function listWorkspaceActivities({ limit = 20 } = {}) {
  const params = new URLSearchParams()
  if (limit) params.append('limit', String(limit))
  const res = await apiClient.get(`/api/workspace-activities?${params.toString()}`)
  const data = extractData(res)
  return data?.items ?? []
}
