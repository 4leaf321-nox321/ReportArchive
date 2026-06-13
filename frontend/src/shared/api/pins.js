import { apiClient, extractData } from './client'

/** 부서 고정 보고서 목록(ReportSummary[], 고정 순서). */
export async function listWorkspacePins(workspaceSlug) {
  const res = await apiClient.get(`/api/workspaces/${workspaceSlug}/pins`)
  return extractData(res)
}

/** 보고서를 부서 홈에 고정(매니저). */
export async function addWorkspacePin(workspaceSlug, reportId) {
  const res = await apiClient.post(`/api/workspaces/${workspaceSlug}/pins`, {
    report_id: reportId,
  })
  return extractData(res)
}

/** 고정 해제(매니저). */
export async function removeWorkspacePin(workspaceSlug, reportId) {
  const res = await apiClient.delete(
    `/api/workspaces/${workspaceSlug}/pins/${reportId}`,
  )
  return extractData(res)
}
