import { apiClient, extractData } from '@/shared/api/client'

const BASE = '/api/reports'

export async function listReports() {
  const res = await apiClient.get(BASE)
  return extractData(res)
}

export async function getReport(id) {
  const res = await apiClient.get(`${BASE}/${id}`)
  return extractData(res)
}

export async function createReport(payload) {
  const res = await apiClient.post(BASE, payload)
  return extractData(res)
}

export async function updateReport(id, payload) {
  const res = await apiClient.patch(`${BASE}/${id}`, payload)
  return extractData(res)
}

export async function deleteReport(id) {
  const res = await apiClient.delete(`${BASE}/${id}`)
  return extractData(res)
}
