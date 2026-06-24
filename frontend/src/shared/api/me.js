import { apiClient, extractData } from './client'

export async function fetchMe() {
  const res = await apiClient.get('/api/me')
  return extractData(res)
}

export async function updateMyProfile({ name }) {
  const res = await apiClient.patch('/api/me', { name })
  return extractData(res)
}

/** 현재 사용자 환경설정 부분 패치(깊은 병합). 보낸 키만 갱신되고 나머지는
 *  유지. 병합된 preferences({ preferences }) 를 반환. */
export async function updateMyPreferences(preferences) {
  const res = await apiClient.patch('/api/me/preferences', { preferences })
  return extractData(res)
}

export async function changeMyPassword({ currentPassword, newPassword }) {
  const res = await apiClient.post('/api/me/password', {
    current_password: currentPassword,
    new_password: newPassword,
  })
  return extractData(res)
}

// ─── 개인 액세스 토큰 (MCP 등 외부 클라이언트) ───
/** 내 토큰 목록(평문 제외). */
export async function listMcpTokens() {
  const res = await apiClient.get('/api/me/mcp-tokens')
  return extractData(res)
}

/** 토큰 발급. 응답 data.token 이 평문(1회만 노출). data.info 는 메타. */
export async function createMcpToken({ name, expiresDays = 90 }) {
  const res = await apiClient.post('/api/me/mcp-tokens', {
    name,
    expires_days: expiresDays,
  })
  return extractData(res)
}

/** 토큰 취소(즉시 무효). */
export async function revokeMcpToken(tokenId) {
  const res = await apiClient.delete(`/api/me/mcp-tokens/${tokenId}`)
  return extractData(res)
}

export async function adminSetUserPassword(userId, { newPassword }) {
  const res = await apiClient.post(`/api/users/${userId}/password`, {
    new_password: newPassword,
  })
  return extractData(res)
}

/** 관리자 — 비밀번호 찾기 요청 대기 목록. */
export async function listPasswordResetRequests() {
  const res = await apiClient.get('/api/password-reset-requests')
  return extractData(res)
}

/** 관리자 — 임시 비번 발급으로 요청 해소. */
export async function resolvePasswordResetRequest(requestId, { newPassword }) {
  const res = await apiClient.post(
    `/api/password-reset-requests/${requestId}/resolve`,
    { new_password: newPassword },
  )
  return extractData(res)
}

/** 관리자 — 처리 불가/무효 요청 반려(취소)로 큐에서 정리. */
export async function dismissPasswordResetRequest(requestId) {
  const res = await apiClient.post(
    `/api/password-reset-requests/${requestId}/dismiss`,
  )
  return extractData(res)
}

/** 시스템 관리자 — 모든 계정 wide view. '계정 관리' 페이지가 사용. */
export async function listAllAccounts({ includeInactive = true } = {}) {
  const res = await apiClient.get('/api/users/all', {
    params: { include_inactive: includeInactive },
  })
  return extractData(res)
}

/** 시스템 관리자 — 한 계정 wide view + 부서 멤버십 전체 목록. 계정 관리
 *  페이지에서 한 행을 클릭했을 때 여는 상세 다이얼로그가 사용. */
export async function getAccountDetail(userId) {
  const res = await apiClient.get(`/api/users/${userId}`)
  return extractData(res)
}

/** 시스템 관리자 — 계정 활성/비활성 토글. */
export async function setUserActive(userId, { isActive }) {
  const res = await apiClient.put(`/api/users/${userId}/active`, {
    is_active: isActive,
  })
  return extractData(res)
}

/** 시스템 관리자 — 사용자 접속(로그인/가입) 이력. 최신순 + 총건수.
 *  success: true(성공)/false(실패)/null(전체), userId 로 한 사용자만.
 *  응답: { items: [...], total }. */
export async function listAccessLogs({
  limit = 200,
  offset = 0,
  userId = null,
  success = null,
} = {}) {
  const params = { limit, offset }
  if (userId != null) params.user_id = userId
  if (success != null) params.success = success
  const res = await apiClient.get('/api/admin/access-logs', { params })
  return extractData(res)
}

/** 시스템 관리자 — 부서별·기간별 접속 통계(막대그래프용).
 *  granularity: 'day' | 'week' | 'month'. success: true(성공)/false(실패)/
 *  null(전체). 응답: { granularity, success, departments, points }. */
export async function accessLogStats({ granularity = 'day', success = true } = {}) {
  const params = { granularity }
  if (success != null) params.success = success
  const res = await apiClient.get('/api/admin/access-logs/stats', { params })
  return extractData(res)
}

/** 시스템 관리자 — 막대(버킷[+부서]) 드릴다운: 그 구간의 사용자별 접속 횟수.
 *  bucket: 'YYYY-MM-DD'(accessLogStats points[].bucket_start). department 생략 시
 *  버킷 전체, '미지정'이면 홈 부서 없는 접속만. 응답: { total, users:[{name,email,count}] }. */
export async function accessLogStatsDetail({
  granularity = 'day',
  bucket,
  department = null,
  success = true,
} = {}) {
  const params = { granularity, bucket }
  if (department != null) params.department = department
  if (success != null) params.success = success
  const res = await apiClient.get('/api/admin/access-logs/stats/detail', {
    params,
  })
  return extractData(res)
}

/** 시스템 관리자 — 사용자의 home(소속) 부서 변경. 새 home 으로 지정된
 *  부서에는 WorkspaceMember 행이 자동으로 확보된다. null/빈 값이면 home
 *  만 해제. */
export async function setUserHomeWorkspace(userId, { workspaceSlug }) {
  const res = await apiClient.put(`/api/users/${userId}/home-workspace`, {
    workspace_slug: workspaceSlug || null,
  })
  return extractData(res)
}
