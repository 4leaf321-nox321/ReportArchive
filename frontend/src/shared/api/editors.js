import { apiClient, extractData } from './client'

/** List the explicit "추가 편집자" grants on a report. Anyone with
 *  report visibility can read this — helpful for "왜 김부장이 편집권을
 *  가진거지?" investigations. */
export async function listReportEditors(reportId) {
  const res = await apiClient.get(`/api/reports/${reportId}/editors`)
  const data = extractData(res)
  return data?.items ?? []
}

/** Grant edit rights to a specific user. Owner-only (server-enforced).
 *  Idempotent — re-adding is a no-op. */
export async function addReportEditor(reportId, userId) {
  const res = await apiClient.post(`/api/reports/${reportId}/editors`, {
    user_id: userId,
  })
  return extractData(res)
}

/** Revoke. Owner-only. */
export async function removeReportEditor(reportId, userId) {
  const res = await apiClient.delete(
    `/api/reports/${reportId}/editors/${userId}`,
  )
  return extractData(res)
}
