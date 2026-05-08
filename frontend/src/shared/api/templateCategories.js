import { apiClient, extractData } from './client'

const BASE = '/api/template-categories'

export async function listTemplateCategories() {
  const res = await apiClient.get(BASE)
  return extractData(res)
}

export async function createTemplateCategory({ slug, name, sortOrder = 0 }) {
  const res = await apiClient.post(BASE, { slug, name, sort_order: sortOrder })
  return extractData(res)
}

export async function updateTemplateCategory(slug, { name, sortOrder } = {}) {
  const payload = {}
  if (name !== undefined) payload.name = name
  if (sortOrder !== undefined) payload.sort_order = sortOrder
  const res = await apiClient.patch(`${BASE}/${slug}`, payload)
  return extractData(res)
}

export async function deleteTemplateCategory(slug) {
  const res = await apiClient.delete(`${BASE}/${slug}`)
  return extractData(res)
}
