import { apiClient, extractData } from './client'

const BASE = '/api/templates'

export async function listTemplates({ onlyLatest = true } = {}) {
  const res = await apiClient.get(BASE, { params: { only_latest: onlyLatest } })
  return extractData(res)
}

export async function getLatestTemplate(templateId) {
  const res = await apiClient.get(`${BASE}/${templateId}`)
  return extractData(res)
}

export async function listTemplateVersions(templateId) {
  const res = await apiClient.get(`${BASE}/${templateId}/versions`)
  return extractData(res)
}

export async function getTemplateVersion(templateId, version) {
  const res = await apiClient.get(`${BASE}/${templateId}/versions/${version}`)
  return extractData(res)
}

export async function createTemplate(payload) {
  const res = await apiClient.post(BASE, payload)
  return extractData(res)
}

export async function publishNewVersion(templateId, payload) {
  const res = await apiClient.post(`${BASE}/${templateId}/versions`, payload)
  return extractData(res)
}

export async function deleteTemplate(templateId) {
  const res = await apiClient.delete(`${BASE}/${templateId}`)
  return extractData(res)
}

/** 다른 부서에 공유 — owner_workspace_slugs(공유 부서)를 통째로 교체.
 *  null/빈 배열 = 전사. 버전은 안 올림(가시성 메타). */
export async function setTemplateScope(templateId, ownerWorkspaceSlugs) {
  const res = await apiClient.patch(`${BASE}/${templateId}/scope`, {
    owner_workspace_slugs: ownerWorkspaceSlugs,
  })
  return extractData(res)
}
