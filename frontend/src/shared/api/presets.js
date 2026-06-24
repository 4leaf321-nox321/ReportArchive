import { apiClient, extractData } from './client'

const BASE = '/api/presets'

/** Presets visible to the current workspace, optionally narrowed to one
 *  template. `scope='all'` 이면 소유 부서 무관 전체(작성 picker — 모든 사용자가
 *  내 공간에서 모든 부서 프리셋으로 시작 가능). 기본은 워크스페이스 스코프. */
export async function listPresets({ templateId, scope } = {}) {
  const params = {}
  if (templateId) params.template_id = templateId
  if (scope) params.scope = scope
  const res = await apiClient.get(BASE, { params })
  return extractData(res)
}

/** Snapshot an existing report into a reusable starting form. */
export async function createPreset(payload) {
  const res = await apiClient.post(BASE, payload)
  return extractData(res)
}

/** Create a new report seeded from a preset. Returns { id, workspace_slug }. */
export async function newReportFromPreset(presetId, { title, folder_id = null } = {}) {
  const res = await apiClient.post(`${BASE}/${presetId}/new-report`, {
    title: title ?? null,
    folder_id,
  })
  return extractData(res)
}

export async function deletePreset(presetId) {
  const res = await apiClient.delete(`${BASE}/${presetId}`)
  return extractData(res)
}
