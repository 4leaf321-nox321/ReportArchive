import { apiClient, extractData } from './client'

// 저장된 검색(스마트 폴더) — 필터 조합을 이름 붙여 저장·적용. 사용자 소유.
// filters 는 서버 appendReportFilters 모양(resolved) — 적용 시 프론트가 UI 상태로
// 역매핑한다. 구독(subscribed)은 후속 알림(#2) 소스.
const BASE = '/api/saved-searches'

export async function listSavedSearches() {
  const res = await apiClient.get(BASE)
  return extractData(res)
}

export async function createSavedSearch({
  name,
  query = '',
  mode = 'keyword',
  filters = {},
  subscribed = false,
  notifyChannel = 'inapp',
} = {}) {
  const res = await apiClient.post(BASE, {
    name,
    query,
    mode,
    filters,
    subscribed,
    notify_channel: notifyChannel,
  })
  return extractData(res)
}

export async function updateSavedSearch(id, patch = {}) {
  // patch: { name?, query?, mode?, filters?, subscribed?, notifyChannel? }
  const body = {}
  for (const k of ['name', 'query', 'mode', 'filters', 'subscribed']) {
    if (patch[k] !== undefined) body[k] = patch[k]
  }
  if (patch.notifyChannel !== undefined) body.notify_channel = patch.notifyChannel
  const res = await apiClient.patch(`${BASE}/${id}`, body)
  return extractData(res)
}

export async function deleteSavedSearch(id) {
  const res = await apiClient.delete(`${BASE}/${id}`)
  return extractData(res)
}
