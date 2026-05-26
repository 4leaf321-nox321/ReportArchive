import { apiClient, extractData } from './client'

/** List users with is_system_admin=true. System-admin only on backend. */
export async function listSystemAdmins() {
  const res = await apiClient.get('/api/users/system-admins')
  return extractData(res)
}

/** Promote / demote a user as system admin. Backend blocks the last
 *  remaining system admin from self-demoting. */
export async function setSystemAdmin(userId, isSystemAdmin) {
  const res = await apiClient.put(`/api/users/${userId}/system-admin`, {
    is_system_admin: isSystemAdmin,
  })
  return extractData(res)
}
