import { apiClient, extractData } from './client'

export async function fetchMe() {
  const res = await apiClient.get('/api/me')
  return extractData(res)
}

export async function updateMyProfile({ name }) {
  const res = await apiClient.patch('/api/me', { name })
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

/** 시스템 관리자 — 모든 계정 wide view. '계정 관리' 페이지가 사용. */
export async function listAllAccounts({ includeInactive = true } = {}) {
  const res = await apiClient.get('/api/users/all', {
    params: { include_inactive: includeInactive },
  })
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
