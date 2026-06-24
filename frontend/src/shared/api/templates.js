import { apiClient, extractData } from './client'

const BASE = '/api/templates'

/**
 * `scope`: 'workspace'(기본) = 현재 워크스페이스 가시 범위로 필터(관리·홈 화면의
 * 조직별 분리 유지). 'all' = 소유 부서 무관 전체 — 작성 picker 용(모든 사용자가
 * 내 공간에서 모든 템플릿을 쓸 수 있어야 함). 렌더(by-id)는 항상 열려 있음.
 */
export async function listTemplates({
  onlyLatest = true,
  scope,
  includeArchived = false,
} = {}) {
  const params = { only_latest: onlyLatest }
  if (scope) params.scope = scope
  if (includeArchived) params.include_archived = true
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

/** 템플릿 보관/보관해제. 보관하면 작성 picker·기본 목록에서 숨지만 기존 보고서
 *  렌더는 그대로(삭제와 달리 행이 살아있음). 보고서가 참조 중이어도 가능. */
export async function setTemplateArchived(templateId, archived) {
  const res = await apiClient.patch(`${BASE}/${templateId}/archive`, {
    archived,
  })
  return extractData(res)
}

/** 이 템플릿으로 작성할 때 노출할 엔티티 축(유효값). 응답:
 *  `{ is_default, items: [{entity_type_id, slug, label, icon, sort_order, required}] }`.
 *  is_default=true 면 명시 바인딩이 없어 전체 축을 기본 노출 중이라는 뜻. */
export async function getTemplateEntityTypes(templateId) {
  const res = await apiClient.get(`${BASE}/${templateId}/entity-types`)
  return extractData(res)
}

/** 노출 축 집합을 통째로 교체. items=[{entity_type_id, required}]. 빈 배열 =
 *  바인딩 없음 = 전체 축 기본 노출. 버전은 안 올림(작성 메타). */
export async function setTemplateEntityTypes(templateId, items) {
  const res = await apiClient.put(`${BASE}/${templateId}/entity-types`, {
    items,
  })
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
