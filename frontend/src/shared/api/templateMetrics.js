import { apiClient, extractData } from './client'

const BASE = '/api/admin/template-metrics'

/** 템플릿 지표 목록(전체 또는 template_id 별). 반환: TemplateMetricRead[] */
export async function listTemplateMetrics(templateId) {
  const qs = templateId ? `?template_id=${encodeURIComponent(templateId)}` : ''
  const res = await apiClient.get(`${BASE}${qs}`)
  return extractData(res)
}

/** 최신 템플릿 schema 의 숫자(key_value) 필드 후보.
 *  반환: { template_id, template_name, version, blocks:[{block_id, block_label, fields:[{key,label,type}]}] } */
export async function getMetricCandidates(templateId) {
  const res = await apiClient.get(
    `${BASE}/candidates?template_id=${encodeURIComponent(templateId)}`,
  )
  return extractData(res)
}

export async function createTemplateMetric(payload) {
  const res = await apiClient.post(BASE, payload)
  return extractData(res)
}

export async function updateTemplateMetric(id, patch) {
  const res = await apiClient.patch(`${BASE}/${id}`, patch)
  return extractData(res)
}

export async function deleteTemplateMetric(id) {
  const res = await apiClient.delete(`${BASE}/${id}`)
  return extractData(res)
}
