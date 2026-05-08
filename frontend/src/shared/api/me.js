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
