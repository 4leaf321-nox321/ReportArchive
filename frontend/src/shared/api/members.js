import { apiClient, extractData } from './client'

const base = (slug) => `/api/workspaces/${slug}/members`

export async function listMembers(workspaceSlug) {
  const res = await apiClient.get(base(workspaceSlug))
  return extractData(res)
}

export async function addMember(workspaceSlug, { email, role }) {
  const res = await apiClient.post(base(workspaceSlug), { email, role })
  return extractData(res)
}

/**
 * `memberId` is workspace_members.id (the row id), not the user id —
 * the same user can have memberships in multiple workspaces, and the row
 * id is what uniquely identifies which one to update or delete.
 */
export async function updateMemberRole(workspaceSlug, memberId, { role }) {
  const res = await apiClient.patch(`${base(workspaceSlug)}/${memberId}`, { role })
  return extractData(res)
}

export async function removeMember(workspaceSlug, memberId) {
  const res = await apiClient.delete(`${base(workspaceSlug)}/${memberId}`)
  return extractData(res)
}

export async function searchUsers({ search = '', limit = 20 } = {}) {
  const res = await apiClient.get('/api/users', { params: { search, limit } })
  return extractData(res)
}
