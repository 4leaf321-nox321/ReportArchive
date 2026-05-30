import { apiClient, extractData } from './client'

// 일반 사용자도 호출 가능 — picker / chip 렌더링에 필요.
export async function listLinkKinds() {
  const res = await apiClient.get('/api/reports/link-kinds')
  return extractData(res)
}

// 이하 admin only — system_admin 이 아니면 백엔드가 403.
export async function adminListLinkKinds() {
  const res = await apiClient.get('/api/admin/link-kinds')
  return extractData(res)
}

export async function adminCreateLinkKind({
  key,
  forwardLabel,
  reverseLabel,
  color,
  sortOrder = 0,
} = {}) {
  const res = await apiClient.post('/api/admin/link-kinds', {
    key,
    forward_label: forwardLabel,
    reverse_label: reverseLabel,
    color,
    sort_order: sortOrder,
  })
  return extractData(res)
}

export async function adminUpdateLinkKind(key, patch = {}) {
  const body = {}
  if (patch.forwardLabel !== undefined) body.forward_label = patch.forwardLabel
  if (patch.reverseLabel !== undefined) body.reverse_label = patch.reverseLabel
  if (patch.color !== undefined) body.color = patch.color
  if (patch.sortOrder !== undefined) body.sort_order = patch.sortOrder
  const res = await apiClient.patch(`/api/admin/link-kinds/${key}`, body)
  return extractData(res)
}

export async function adminDeleteLinkKind(key) {
  const res = await apiClient.delete(`/api/admin/link-kinds/${key}`)
  return extractData(res)
}
