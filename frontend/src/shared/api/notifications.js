import { apiClient, extractData } from './client'

const BASE = '/api/notifications'

/** Returns `{ items, unread_count }`. */
export async function listNotifications({ unreadOnly = false, limit = 50, beforeId } = {}) {
  const params = new URLSearchParams()
  if (unreadOnly) params.append('unread_only', 'true')
  if (limit) params.append('limit', String(limit))
  if (beforeId) params.append('before_id', String(beforeId))
  const qs = params.toString()
  const res = await apiClient.get(qs ? `${BASE}?${qs}` : BASE)
  const data = extractData(res)
  return {
    items: data?.items ?? [],
    unread_count: data?.unread_count ?? 0,
  }
}

export async function getUnreadCount() {
  const res = await apiClient.get(`${BASE}/unread-count`)
  return extractData(res)?.unread_count ?? 0
}

export async function markRead(notificationId) {
  const res = await apiClient.patch(`${BASE}/${notificationId}/read`)
  return extractData(res)
}

export async function markAllRead() {
  const res = await apiClient.post(`${BASE}/mark-all-read`)
  return extractData(res)
}

export async function deleteNotification(notificationId) {
  const res = await apiClient.delete(`${BASE}/${notificationId}`)
  return extractData(res)
}

/** Bulk delete all READ notifications for the current user. Unread
 *  notifications are preserved. Returns `{ deleted: <count> }`. */
export async function deleteAllRead() {
  const res = await apiClient.delete(`${BASE}/read`)
  return extractData(res)
}
