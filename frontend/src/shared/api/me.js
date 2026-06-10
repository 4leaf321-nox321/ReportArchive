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

/** 시스템 관리자 — 사용자의 home(소속) 부서 변경. 새 home 으로 지정된
 *  부서에는 WorkspaceMember 행이 자동으로 확보된다. null/빈 값이면 home
 *  만 해제. */
export async function setUserHomeWorkspace(userId, { workspaceSlug }) {
  const res = await apiClient.put(`/api/users/${userId}/home-workspace`, {
    workspace_slug: workspaceSlug || null,
  })
  return extractData(res)
}
