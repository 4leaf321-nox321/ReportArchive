import { apiClient, extractData } from './client'

const BASE = '/api/composites'

export async function listComposites() {
  const res = await apiClient.get(BASE)
  return extractData(res)
}

export async function getComposite(id) {
  const res = await apiClient.get(`${BASE}/${id}`)
  return extractData(res)
}

export async function createComposite(payload) {
  const res = await apiClient.post(BASE, payload)
  return extractData(res)
}

export async function updateComposite(id, payload) {
  const res = await apiClient.patch(`${BASE}/${id}`, payload)
  return extractData(res)
}

export async function deleteComposite(id) {
  const res = await apiClient.delete(`${BASE}/${id}`)
  return extractData(res)
}

/** Owner-only: 발행. For kind=recurring this freezes each item's source
 *  report content into snapshot_content; for theme it just stamps
 *  published_at (no snapshot since theme is always live). Idempotent. */
export async function publishComposite(id) {
  const res = await apiClient.post(`${BASE}/${id}/publish`)
  return extractData(res)
}

/** Owner-only: 발행 취소. Clears published_at + per-item snapshots so
 *  the composite goes back to live + editable. Idempotent. */
export async function unpublishComposite(id) {
  const res = await apiClient.post(`${BASE}/${id}/unpublish`)
  return extractData(res)
}

/** Every composite that references the given report as an item. Drives
 *  the report-detail "포함된 종합 문서 N개" chip (Phase 5C). Returns slim
 *  CompositeRef shape — just enough to identify + navigate. */
export async function listCompositesContainingReport(reportId) {
  const res = await apiClient.get(`${BASE}/by-report/${reportId}`)
  return extractData(res) ?? []
}
