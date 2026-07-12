import { apiClient, extractData } from './client'

// Phase D 경보(관리자) — 규칙 목록·조정·수동 실행·발화 목록. 1단계=수동.
const BASE = '/api/alerts'

/** 규칙 목록(각 규칙의 현재 발화 수 firing_count 포함). */
export async function listAlertRules() {
  const res = await apiClient.get(`${BASE}/rules`)
  return extractData(res)
}

/** 규칙 조정 — { enabled?, params? } (params: {days, finalized_only}). */
export async function updateAlertRule(ruleId, payload) {
  const res = await apiClient.patch(`${BASE}/rules/${ruleId}`, payload)
  return extractData(res)
}

/** 수동 실행 — 프로브 평가 + 발화/해소. 요약 { checked, fired, resolved, firing, capped }. */
export async function runAlertRule(ruleId) {
  const res = await apiClient.post(`${BASE}/rules/${ruleId}/run`)
  return extractData(res)
}

/** 현재 발화 목록(인박스). 페이지네이션 { limit, offset } → { items, total }. */
export async function listAlertFiring(ruleId, { limit = 50, offset = 0 } = {}) {
  const res = await apiClient.get(`${BASE}/rules/${ruleId}/firing`, {
    params: { limit, offset },
  })
  return extractData(res)
}
