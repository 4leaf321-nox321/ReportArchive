import { apiClient, extractData } from './client'

const BASE = '/api/presets'

/** Presets visible to the current workspace (전사 + own tree), optionally
 *  narrowed to one template. */
export async function listPresets({ templateId } = {}) {
  const res = await apiClient.get(BASE, {
    params: templateId ? { template_id: templateId } : {},
  })
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
