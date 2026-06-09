import { apiClient, extractData } from './client'

// 게시판별 게시취소 요청 큐 (보고서 삭제 재설계 2단계).
//
// 작성자가 "게시판에서 내리기"를 요청하면 게시된 부서 게시판마다 팬아웃된다.
// 요청자가 관리하는 게시판은 즉시 게시취소되고, 나머지는 그 board 매니저의
// 승인을 기다린다. 매니저는 자기 게시판(/w/:slug/members)에서 큐를 본다.

/** 작성자: 이 보고서를 게시된 모든 부서 게시판에서 내리기 요청.
 *  반환 { requested, auto_removed }. */
export async function requestTakedown(reportId) {
  const res = await apiClient.post(`/api/reports/${reportId}/takedown-requests`)
  return extractData(res)
}

/** 매니저: 현재 게시판(X-Workspace-Slug)에 들어온 pending 요청 목록. */
export async function listTakedownRequests() {
  const res = await apiClient.get('/api/takedown-requests')
  return extractData(res) ?? []
}

/** 매니저: 승인 → 그 게시판에서 게시취소. */
export async function approveTakedown(requestId) {
  const res = await apiClient.post(`/api/takedown-requests/${requestId}/approve`)
  return extractData(res)
}

/** 매니저: 거절 → 게시 유지. */
export async function rejectTakedown(requestId) {
  const res = await apiClient.post(`/api/takedown-requests/${requestId}/reject`)
  return extractData(res)
}
