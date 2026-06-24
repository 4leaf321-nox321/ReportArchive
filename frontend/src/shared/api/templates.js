import { apiClient, extractData } from './client'

const BASE = '/api/templates'

/**
 * `scope`: 'workspace'(기본) = 현재 워크스페이스 가시 범위로 필터(관리·홈 화면의
 * 조직별 분리 유지). 'all' = 소유 부서 무관 전체 — 작성 picker 용(모든 사용자가
 * 내 공간에서 모든 템플릿을 쓸 수 있어야 함). 렌더(by-id)는 항상 열려 있음.
 */
export async function listTemplates({ onlyLatest = true, scope } = {}) {
  const params = { only_latest: onlyLatest }
  if (scope) params.scope = scope
  const res = await apiClient.get(BASE, { params })
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
