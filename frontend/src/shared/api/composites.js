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

/** 조직 간 공개 토글 — 종합보고를 다른 조직이 읽기전용으로 조회 가능하게.
 *  소유자·부서 매니저·시스템관리자 전용 별도 엔드포인트(일반 PATCH 와 분리해
 *  공개 권한만 좁힘 — 워크스페이스 /external-view 와 동형). */
export async function setCompositeExternalView(id, externalView) {
  const res = await apiClient.patch(`${BASE}/${id}/external-view`, {
    external_view: externalView,
  })
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

// ── 안건 제출(신청) 큐 ─────────────────────────────────────────────────
/** 이 보고서를 안건으로 제출할 수 있는 종합보고 목록(+already_item/pending). */
export async function listSubmittableComposites(reportId) {
  const res = await apiClient.get(`${BASE}/submittable-for/${reportId}`)
  return extractData(res) ?? []
}

/** 보고서를 종합보고에 안건으로 제출. */
export async function submitItemRequest(compositeId, { ref_report_id, note }) {
  const res = await apiClient.post(`${BASE}/${compositeId}/requests`, {
    ref_report_id,
    note: note ?? '',
  })
  return extractData(res)
}

/** 종합보고의 제출 요청 목록(기본 pending). */
export async function listItemRequests(compositeId, status) {
  const qs = status ? `?status_filter=${encodeURIComponent(status)}` : ''
  const res = await apiClient.get(`${BASE}/${compositeId}/requests${qs}`)
  return extractData(res) ?? []
}

/** owner: 제출 승인 → 안건으로 추가. */
export async function acceptItemRequest(compositeId, reqId) {
  const res = await apiClient.post(
    `${BASE}/${compositeId}/requests/${reqId}/accept`,
  )
  return extractData(res)
}

/** owner: 제출 반려. */
export async function rejectItemRequest(compositeId, reqId) {
  const res = await apiClient.post(
    `${BASE}/${compositeId}/requests/${reqId}/reject`,
  )
  return extractData(res)
}

/** 제출자 본인(또는 owner): 제출 철회. */
export async function withdrawItemRequest(compositeId, reqId) {
  const res = await apiClient.post(
    `${BASE}/${compositeId}/requests/${reqId}/withdraw`,
  )
  return extractData(res)
}
