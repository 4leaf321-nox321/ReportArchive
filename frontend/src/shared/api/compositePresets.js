import { apiClient, extractData } from './client'

const BASE = '/api/composite-presets'

/** 종합보고 양식 목록 — 현재 워크스페이스 트리(전사 + own tree)에서 보이는 것. */
export async function listCompositePresets() {
  const res = await apiClient.get(BASE)
  return extractData(res)
}

/** 종합보고를 재사용 가능한 양식으로 스냅샷. `groups` 는 빈 그룹 포함
 *  현재 draft 의 전체 그룹 골격(순서 유지). */
export async function createCompositePreset(payload) {
  const res = await apiClient.post(BASE, payload)
  return extractData(res)
}

/** 양식에서 새 종합보고 생성. Returns { composite, seed_groups } — seed_groups
 *  는 안건이 없어 DB 에 못 들어간 빈 그룹 골격(프런트가 pendingGroups 로 시딩). */
export async function newCompositeFromPreset(
  presetId,
  { workspace_slug, title, kind, period_date = null } = {},
) {
  const res = await apiClient.post(`${BASE}/${presetId}/new-composite`, {
    workspace_slug,
    title,
    kind,
    period_date,
  })
  return extractData(res)
}

/** 양식의 메타정보(이름·설명·공개범위) + 그룹 목록 수정. 관리 탭 전용.
 *  owner_workspace_slugs: null = 전사, [slug...] = 특정 조직. groups: 빈 그룹
 *  포함 전체 골격(순서 유지). 보낸 필드만 반영된다. */
export async function updateCompositePreset(presetId, payload) {
  const res = await apiClient.patch(`${BASE}/${presetId}`, payload)
  return extractData(res)
}

export async function deleteCompositePreset(presetId) {
  const res = await apiClient.delete(`${BASE}/${presetId}`)
  return extractData(res)
}
