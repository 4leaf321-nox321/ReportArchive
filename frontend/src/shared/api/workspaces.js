import { apiClient, extractData } from './client'

const BASE = '/api/workspaces'

export async function listWorkspaces() {
  const res = await apiClient.get(BASE)
  return extractData(res)
}

export async function createWorkspace({
  slug,
  name,
  parentSlug = null,
  description = '',
  sortOrder = 0,
}) {
  const res = await apiClient.post(BASE, {
    slug,
    name,
    parent_slug: parentSlug,
    description,
    sort_order: sortOrder,
  })
  return extractData(res)
}

/**
 * `parentSlug` is special: explicit null means "move to root", omission means
 * "leave unchanged". We distinguish via `'parentSlug' in options`, so
 * `updateWorkspace(slug, { parentSlug: null })` actually moves to root.
 *
 * Color is server-derived from the tree and not accepted here.
 */
export async function updateWorkspace(slug, options = {}) {
  const payload = {}
  if (options.name !== undefined) payload.name = options.name
  if (options.description !== undefined) payload.description = options.description
  if (options.sortOrder !== undefined) payload.sort_order = options.sortOrder
  if ('parentSlug' in options) payload.parent_slug = options.parentSlug
  const res = await apiClient.patch(`${BASE}/${slug}`, payload)
  return extractData(res)
}

/**
 * Bulk-create from a pasted table. `items` is an array of
 * { name, parentName? } — parentName matches by display name against
 * existing depts or earlier rows in the same batch. Empty parentName
 * means a root dept.
 */
export async function bulkCreateWorkspaces(items) {
  const res = await apiClient.post(`${BASE}/bulk`, {
    items: items.map((i) => ({
      name: i.name,
      parent_name: i.parentName || null,
    })),
  })
  return extractData(res)
}

export async function deleteWorkspace(slug) {
  const res = await apiClient.delete(`${BASE}/${slug}`)
  return extractData(res)
}

export async function getWorkspaceDependents(slug) {
  const res = await apiClient.get(`${BASE}/${slug}/dependents`)
  return extractData(res)
}
