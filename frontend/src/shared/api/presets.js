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

/** 양식 메타정보(이름·설명·공개범위) 수정 — 작성자 또는 시스템관리자. */
export async function updatePreset(
  presetId,
  { name, description, ownerWorkspaceSlugs } = {},
) {
  const body = {}
  if (name !== undefined) body.name = name
  if (description !== undefined) body.description = description
  if (ownerWorkspaceSlugs !== undefined)
    body.owner_workspace_slugs = ownerWorkspaceSlugs
  const res = await apiClient.patch(`${BASE}/${presetId}`, body)
  return extractData(res)
}

/** 양식 내용(seed)을 source 보고서로 갱신 — 양식 편집 세션의 '양식에 반영'. */
export async function updatePresetFromReport(presetId, sourceReportId) {
  const res = await apiClient.post(`${BASE}/${presetId}/update-from-report`, {
    source_report_id: sourceReportId,
  })
  return extractData(res)
}

export async function deletePreset(presetId) {
  const res = await apiClient.delete(`${BASE}/${presetId}`)
  return extractData(res)
}
