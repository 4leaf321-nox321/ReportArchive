import { apiClient, extractData } from './client'

const BASE = '/api/workspaces'

export async function listWorkspaces() {
  const res = await apiClient.get(BASE)
  return extractData(res)
}

export async function createWorkspace({
  slug,
  name,
  parentSlug = null,
  description = '',
  sortOrder = 0,
}) {
  const res = await apiClient.post(BASE, {
    slug,
    name,
    parent_slug: parentSlug,
    description,
    sort_order: sortOrder,
  })
  return extractData(res)
}

/**
 * `parentSlug` is special: explicit null means "move to root", omission means
 * "leave unchanged". We distinguish via `'parentSlug' in options`, so
 * `updateWorkspace(slug, { parentSlug: null })` actually moves to root.
 *
 * Color is server-derived from the tree and not accepted here.
 */
export async function updateWorkspace(slug, options = {}) {
  const payload = {}
  if (options.name !== undefined) payload.name = options.name
  if (options.description !== undefined) payload.description = options.description
  if (options.sortOrder !== undefined) payload.sort_order = options.sortOrder
  if ('parentSlug' in options) payload.parent_slug = options.parentSlug
  const res = await apiClient.patch(`${BASE}/${slug}`, payload)
  return extractData(res)
}

/**
 * Bulk-create from a pasted table. `items` is an array of
 * { name, parentName? } — parentName matches by display name against
 * existing depts or earlier rows in the same batch. Empty parentName
 * means a root dept.
 */
export async function bulkCreateWorkspaces(items) {
  const res = await apiClient.post(`${BASE}/bulk`, {
    items: items.map((i) => ({
      name: i.name,
      parent_name: i.parentName || null,
    })),
  })
  return extractData(res)
}

/**
 * 게시판 기본 공개정책(external_view_default) 토글 — 시스템관리자 전용인
 * updateWorkspace 와 분리된 매니저 위임 엔드포인트(조직간공개_설계.md §8 (a)).
 */
export async function setWorkspaceExternalView(slug, externalViewDefault) {
  const res = await apiClient.patch(`${BASE}/${slug}/external-view`, {
    external_view_default: externalViewDefault,
  })
  return extractData(res)
}

/**
 * TF(태스크포스) 개설 — 보직장(org 매니저) 이상 self-service(TF조직_설계.md §4).
 * 슬러그·parent 는 서버가 결정(트리 밖). `memberEmails` 로 부서 무관 차출.
 * 미가입 이메일은 서버가 건너뛰고 응답 message 로 알린다.
 */
export async function createTfWorkspace({ name, description = '', memberEmails = [] }) {
  const res = await apiClient.post(`${BASE}/tf`, {
    name,
    description,
    member_emails: memberEmails,
  })
  // 누락 이메일 안내(message)도 함께 노출할 수 있게 envelope 채로 반환.
  return { data: extractData(res), message: res?.data?.message ?? null }
}

/** TF 보관/복원(읽기전용 보존) — 그 TF 매니저 또는 시스템관리자(TF조직_설계.md §7). */
export async function setWorkspaceArchived(slug, archived) {
  const res = await apiClient.patch(`${BASE}/${slug}/archive`, { archived })
  return extractData(res)
}

/** 시스템관리자 감독용 — 모든 TF(보관 포함). */
export async function listAllTf() {
  const res = await apiClient.get(`${BASE}/tf/all`)
  return extractData(res)
}

export async function deleteWorkspace(slug) {
  const res = await apiClient.delete(`${BASE}/${slug}`)
  return extractData(res)
}

export async function getWorkspaceDependents(slug) {
  const res = await apiClient.get(`${BASE}/${slug}/dependents`)
  return extractData(res)
}
