import { apiClient, extractData } from './client'

const BASE = '/api/folders'

/** List folders. Personal scope when `workspaceSlug` omitted; org
 *  scope when supplied. Returns `{ items, uncategorized_count }`. */
export async function listFolders({ workspaceSlug } = {}) {
  const url = workspaceSlug
    ? `${BASE}?workspace_slug=${encodeURIComponent(workspaceSlug)}`
    : BASE
  const res = await apiClient.get(url)
  const data = extractData(res)
  return {
    items: data?.items ?? [],
    uncategorized_count: data?.uncategorized_count ?? 0,
  }
}

export async function createFolder({
  name,
  parentId = null,
  sortOrder = 0,
  workspaceSlug,
}) {
  const url = workspaceSlug
    ? `${BASE}?workspace_slug=${encodeURIComponent(workspaceSlug)}`
    : BASE
  const res = await apiClient.post(url, {
    name,
    parent_id: parentId,
    sort_order: sortOrder,
  })
  return extractData(res)
}

export async function updateFolder(id, patch) {
  // Pass-through with snake_case mapping. Only forward keys the caller
  // actually set so the backend's exclude_unset path triggers correctly.
  const body = {}
  if ('name' in patch) body.name = patch.name
  if ('parentId' in patch) body.parent_id = patch.parentId
  if ('sortOrder' in patch) body.sort_order = patch.sortOrder
  const res = await apiClient.patch(`${BASE}/${id}`, body)
  return extractData(res)
}

export async function deleteFolder(id) {
  const res = await apiClient.delete(`${BASE}/${id}`)
  return extractData(res)
}
