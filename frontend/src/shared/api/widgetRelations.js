import { apiClient, extractData } from './client'

const BASE = '/api/widget-relations'

export async function listWidgetRelations() {
  const res = await apiClient.get(BASE)
  return extractData(res)
}

export async function createWidgetRelation({
  slug,
  name,
  description,
  hintKeywords = [],
  sortOrder = 0,
}) {
  const res = await apiClient.post(BASE, {
    slug,
    name,
    description: description || undefined,
    hint_keywords: hintKeywords,
    sort_order: sortOrder,
  })
  return extractData(res)
}

export async function updateWidgetRelation(slug, patch = {}) {
  const payload = {}
  if (patch.name !== undefined) payload.name = patch.name
  if (patch.description !== undefined) payload.description = patch.description
  if (patch.hintKeywords !== undefined) payload.hint_keywords = patch.hintKeywords
  if (patch.sortOrder !== undefined) payload.sort_order = patch.sortOrder
  const res = await apiClient.patch(`${BASE}/${slug}`, payload)
  return extractData(res)
}

export async function deleteWidgetRelation(slug) {
  const res = await apiClient.delete(`${BASE}/${slug}`)
  return extractData(res)
}
