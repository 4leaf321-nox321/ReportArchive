import { apiClient, extractData } from './client'

/**
 * 작업 큐 운영(관리자) API — AI 설정 → "작업 큐" 탭. 전부 시스템 관리자 전용
 * (백엔드 require_system_admin). 큐 상태를 보고 실패 잡을 재시도/취소/정리한다.
 */

const BASE = '/api/jobs/admin'

/** 큐 요약 — { by_status, by_type, pending, running, failed, done, canceled,
 *  oldest_pending_age_s, recent_failed, recent_failed_hours } */
export async function getJobStats() {
  return extractData(await apiClient.get(`${BASE}/stats`))
}

/** 워커·LLM 헬스 — { worker:{alive,count,workers[],window_s}, llm:{backend,reachable,...} } */
export async function getJobsHealth() {
  return extractData(await apiClient.get(`${BASE}/health`))
}

/** 필터된 전체 잡 목록 — { items[], total, limit, offset } */
export async function listJobs({ status, type, limit = 50, offset = 0 } = {}) {
  const params = { limit, offset }
  if (status) params.status = status
  if (type) params.type = type
  return extractData(await apiClient.get(BASE, { params }))
}

/** 단건 재시도(failed/canceled → pending). */
export async function retryJob(id) {
  return extractData(await apiClient.post(`${BASE}/${id}/retry`))
}

/** 일괄 재시도(필터에 맞는 잡). 기본 status=failed. → { requeued } */
export async function retryJobs({ status = 'failed', type } = {}) {
  return extractData(await apiClient.post(`${BASE}/retry`, { status, type: type ?? null }))
}

/** 단건 취소(pending → canceled). */
export async function cancelJob(id) {
  return extractData(await apiClient.post(`${BASE}/${id}/cancel`))
}

/** 오래된 종결 잡 정리(done/canceled/failed). → { purged } */
export async function purgeJobs({ status = 'done', olderThanDays = 7 } = {}) {
  return extractData(
    await apiClient.delete(BASE, { params: { status, older_than_days: olderThanDays } }),
  )
}
