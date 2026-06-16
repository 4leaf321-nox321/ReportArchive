import { apiClient, extractData } from './client'

/** 통합 공유(content_grant) API — 보고서·종합보고 공통.
 *  contentType ∈ 'reports' | 'composites'. */

export async function listShares(contentType, id) {
  const res = await apiClient.get(`/api/${contentType}/${id}/shares`)
  return extractData(res) ?? []
}

/** principal_type ∈ 'workspace' | 'user' | 'all_org', level ∈ 'view' | 'edit'.
 *  all_org 는 ref 없이 view 로 강제됨(백엔드). */
export async function addShare(contentType, id, { principalType, principalRef, level }) {
  const res = await apiClient.post(`/api/${contentType}/${id}/shares`, {
    principal_type: principalType,
    principal_ref: principalRef ?? null,
    level: level ?? 'view',
  })
  return extractData(res)
}

export async function removeShare(contentType, id, grantId) {
  const res = await apiClient.delete(`/api/${contentType}/${id}/shares/${grantId}`)
  return extractData(res)
}

/** 게시판(워크스페이스) 통째 공유 — 그 게시판 보고서·종합보고가 대상에게 보임.
 *  추가/삭제는 게시판 매니저 + 시스템관리자. */
export async function listBoardShares(slug) {
  const res = await apiClient.get(`/api/workspaces/${slug}/shares`)
  return extractData(res) ?? []
}

export async function addBoardShare(slug, { principalType, principalRef, level }) {
  const res = await apiClient.post(`/api/workspaces/${slug}/shares`, {
    principal_type: principalType,
    principal_ref: principalRef ?? null,
    level: level ?? 'view',
  })
  return extractData(res)
}

export async function removeBoardShare(slug, grantId) {
  const res = await apiClient.delete(`/api/workspaces/${slug}/shares/${grantId}`)
  return extractData(res)
}

/** 폴더 통째 공유 — 그 폴더에 게시된 보고서가 대상에게 보임.
 *  추가/삭제는 폴더 게시판 매니저 + 시스템관리자. */
export async function listFolderShares(folderId) {
  const res = await apiClient.get(`/api/folders/${folderId}/shares`)
  return extractData(res) ?? []
}

export async function addFolderShare(folderId, { principalType, principalRef, level }) {
  const res = await apiClient.post(`/api/folders/${folderId}/shares`, {
    principal_type: principalType,
    principal_ref: principalRef ?? null,
    level: level ?? 'view',
  })
  return extractData(res)
}

export async function removeFolderShare(folderId, grantId) {
  const res = await apiClient.delete(`/api/folders/${folderId}/shares/${grantId}`)
  return extractData(res)
}

/** 종합보고 워크스페이스 기본 공유 — 이 부서가 home 인 종합보고가 대상에게
 *  기본으로 보임(라이브 상속). 추가/삭제는 게시판 매니저 + 시스템관리자. */
export async function listCompositeDefaultShares(slug) {
  const res = await apiClient.get(
    `/api/workspaces/${slug}/composite-default-shares`,
  )
  return extractData(res) ?? []
}

export async function addCompositeDefaultShare(
  slug,
  { principalType, principalRef, level },
) {
  const res = await apiClient.post(
    `/api/workspaces/${slug}/composite-default-shares`,
    {
      principal_type: principalType,
      principal_ref: principalRef ?? null,
      level: level ?? 'view',
    },
  )
  return extractData(res)
}

export async function removeCompositeDefaultShare(slug, grantId) {
  const res = await apiClient.delete(
    `/api/workspaces/${slug}/composite-default-shares/${grantId}`,
  )
  return extractData(res)
}

/** 모드(folderId > compositeDefaultSlug > boardSlug > contentType/contentId)에
 *  맞는 list/add/remove 를 묶어 돌려준다. ShareEditor·SharePopover 가 공통으로 쓴다. */
export function shareApi({
  contentType,
  contentId,
  boardSlug,
  folderId,
  compositeDefaultSlug,
}) {
  if (folderId) {
    return {
      list: () => listFolderShares(folderId),
      add: (p) => addFolderShare(folderId, p),
      remove: (g) => removeFolderShare(folderId, g),
    }
  }
  if (compositeDefaultSlug) {
    return {
      list: () => listCompositeDefaultShares(compositeDefaultSlug),
      add: (p) => addCompositeDefaultShare(compositeDefaultSlug, p),
      remove: (g) => removeCompositeDefaultShare(compositeDefaultSlug, g),
    }
  }
  if (boardSlug) {
    return {
      list: () => listBoardShares(boardSlug),
      add: (p) => addBoardShare(boardSlug, p),
      remove: (g) => removeBoardShare(boardSlug, g),
    }
  }
  return {
    list: () => listShares(contentType, contentId),
    add: (p) => addShare(contentType, contentId, p),
    remove: (g) => removeShare(contentType, contentId, g),
  }
}
