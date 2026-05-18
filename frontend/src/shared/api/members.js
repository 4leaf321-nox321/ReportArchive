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
 *
 * `workspaceSlug` (URL) is the admin's viewing context; the optional
 * `targetWorkspaceSlug` in options is where the membership should move
 * to (must be the same workspace or a descendant). Omit to keep current.
 */
export async function updateMember(workspaceSlug, memberId, options = {}) {
  const body = {}
  if (options.role !== undefined) body.role = options.role
  if (options.targetWorkspaceSlug !== undefined) body.workspace_slug = options.targetWorkspaceSlug
  const res = await apiClient.patch(`${base(workspaceSlug)}/${memberId}`, body)
  return extractData(res)
}

// Backwards-compatible alias — role-only shortcut.
export const updateMemberRole = (workspaceSlug, memberId, { role }) =>
  updateMember(workspaceSlug, memberId, { role })

export async function removeMember(workspaceSlug, memberId) {
  const res = await apiClient.delete(`${base(workspaceSlug)}/${memberId}`)
  return extractData(res)
}

export async function searchUsers({ search = '', limit = 20 } = {}) {
  const res = await apiClient.get('/api/users', { params: { search, limit } })
  return extractData(res)
}
