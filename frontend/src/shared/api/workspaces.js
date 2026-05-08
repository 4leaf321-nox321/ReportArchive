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
  color = 'bg-slate-500',
  sortOrder = 0,
}) {
  const res = await apiClient.post(BASE, {
    slug,
    name,
    parent_slug: parentSlug,
    description,
    color,
    sort_order: sortOrder,
  })
  return extractData(res)
}

/**
 * `parentSlug` is special: explicit null means "move to root", omission means
 * "leave unchanged". We distinguish via `'parentSlug' in options`, so
 * `updateWorkspace(slug, { parentSlug: null })` actually moves to root.
 */
export async function updateWorkspace(slug, options = {}) {
  const payload = {}
  if (options.name !== undefined) payload.name = options.name
  if (options.description !== undefined) payload.description = options.description
  if (options.color !== undefined) payload.color = options.color
  if (options.sortOrder !== undefined) payload.sort_order = options.sortOrder
  if ('parentSlug' in options) payload.parent_slug = options.parentSlug
  const res = await apiClient.patch(`${BASE}/${slug}`, payload)
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
