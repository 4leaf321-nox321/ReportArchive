import { apiClient, extractData } from './client'

const BASE = '/api/notices'

/**
 * Server-paginated notice list. Returns
 *   { items: NoticePostRead[], total, limit, offset }
 * Pinned notices sort first, then newest first. Any authenticated user
 * can read; only system admins can create/edit/delete.
 */
export async function listNotices({ limit = 200, offset = 0 } = {}) {
  const res = await apiClient.get(BASE, { params: { limit, offset } })
  return extractData(res)
}

export async function getNotice(id) {
  const res = await apiClient.get(`${BASE}/${id}`)
  return extractData(res)
}

export async function createNotice({ title, body, pinned = false, attachments = [] }) {
  const res = await apiClient.post(BASE, { title, body, pinned, attachments })
  return extractData(res)
}

export async function updateNotice(id, patch) {
  const payload = {}
  if (patch.title !== undefined) payload.title = patch.title
  if (patch.body !== undefined) payload.body = patch.body
  if (patch.pinned !== undefined) payload.pinned = patch.pinned
  if (patch.attachments !== undefined) payload.attachments = patch.attachments
  const res = await apiClient.patch(`${BASE}/${id}`, payload)
  return extractData(res)
}

export async function deleteNotice(id) {
  const res = await apiClient.delete(`${BASE}/${id}`)
  return extractData(res)
}

/**
 * 접속자에게 띄울 팝업 공지 1건(없으면 null). 서버가 사용자별 seen
 * high-water mark 와 비교해 '가장 최근 공지가 아직 확인 전일 때'만 돌려준다.
 */
export async function getNoticePopup() {
  const res = await apiClient.get(`${BASE}/popup`)
  return extractData(res)
}

/** 팝업 확인 처리 — 이 id 이하 공지는 다시 팝업되지 않는다(서버 저장). */
export async function markNoticePopupSeen(noticeId) {
  const res = await apiClient.post(`${BASE}/popup/seen`, { notice_id: noticeId })
  return extractData(res)
}
