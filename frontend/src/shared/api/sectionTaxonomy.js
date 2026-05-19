import { apiClient, extractData } from './client'

const BASE = '/api/section-taxonomy'

// ---------------------------------------------------------------------- //
// Categories                                                              //
// ---------------------------------------------------------------------- //

/** Returns every category with its `items` array embedded — the picker
 *  and the badge resolver both want the full tree, so the API ships
 *  them together. */
export async function listSectionCategories() {
  const res = await apiClient.get(`${BASE}/categories`)
  return extractData(res)
}

export async function createSectionCategory({ slug, name, color, sortOrder = 0 }) {
  const res = await apiClient.post(`${BASE}/categories`, {
    slug,
    name,
    color,
    sort_order: sortOrder,
  })
  return extractData(res)
}

export async function updateSectionCategory(slug, patch = {}) {
  const payload = {}
  if (patch.name !== undefined) payload.name = patch.name
  if (patch.color !== undefined) payload.color = patch.color
  if (patch.sortOrder !== undefined) payload.sort_order = patch.sortOrder
  const res = await apiClient.patch(`${BASE}/categories/${slug}`, payload)
  return extractData(res)
}

export async function deleteSectionCategory(slug) {
  const res = await apiClient.delete(`${BASE}/categories/${slug}`)
  return extractData(res)
}

// ---------------------------------------------------------------------- //
// Items                                                                   //
// ---------------------------------------------------------------------- //

export async function createSectionItem({
  code,
  categorySlug,
  label,
  en,
  sortOrder = 0,
}) {
  const res = await apiClient.post(`${BASE}/items`, {
    code,
    category_slug: categorySlug,
    label,
    en: en || undefined,
    sort_order: sortOrder,
  })
  return extractData(res)
}

export async function updateSectionItem(code, patch = {}) {
  const payload = {}
  if (patch.categorySlug !== undefined) payload.category_slug = patch.categorySlug
  if (patch.label !== undefined) payload.label = patch.label
  if (patch.en !== undefined) payload.en = patch.en
  if (patch.sortOrder !== undefined) payload.sort_order = patch.sortOrder
  const res = await apiClient.patch(`${BASE}/items/${code}`, payload)
  return extractData(res)
}

export async function deleteSectionItem(code) {
  const res = await apiClient.delete(`${BASE}/items/${code}`)
  return extractData(res)
}
