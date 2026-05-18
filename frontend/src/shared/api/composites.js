import { apiClient, extractData } from './client'

const BASE = '/api/composites'

export async function listComposites() {
  const res = await apiClient.get(BASE)
  return extractData(res)
}

export async function getComposite(id) {
  const res = await apiClient.get(`${BASE}/${id}`)
  return extractData(res)
}

export async function createComposite(payload) {
  const res = await apiClient.post(BASE, payload)
  return extractData(res)
}

export async function updateComposite(id, payload) {
  const res = await apiClient.patch(`${BASE}/${id}`, payload)
  return extractData(res)
}

export async function deleteComposite(id) {
  const res = await apiClient.delete(`${BASE}/${id}`)
  return extractData(res)
}
