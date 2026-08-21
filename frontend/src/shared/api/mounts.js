import { apiClient, extractData } from './client'

const BASE = '/api/mounts'

/** List every org board this report is mounted on. */
export async function listMounts(reportId) {
  const res = await apiClient.get(BASE, { params: { report_id: reportId } })
  const data = extractData(res)
  return data?.items ?? []
}

/**
 * 게시 후보를 넓히는 보조 목록 — 멤버는 아니지만 편집 권한(board edit
 * grant)이 열려 있어 게시할 수 있는 게시판 slug 들. MountDialog 가 멤버십
 * 기반 후보에 union 해서 표시한다.
 */
export async function listGrantBoardSlugs() {
  const res = await apiClient.get(`${BASE}/grant-board-slugs`)
  const data = extractData(res)
  return data?.slugs ?? []
}

/**
 * Mount a report to one or more org boards in a single request.
 * Idempotent per-target — already-mounted boards are silently skipped.
 */
export async function mountReport({
  reportId,
  workspaceSlugs,
  editPolicy = 'default',
  note = '',
  folderId = null,
  folderIds = [],
}) {
  const res = await apiClient.post(BASE, {
    report_id: reportId,
    workspace_slugs: workspaceSlugs,
    edit_policy: editPolicy,
    note,
    folder_id: folderId,
    folder_ids: folderIds,
  })
  const data = extractData(res)
  return data?.items ?? []
}

/** Move an existing mount to ONE org folder (null = 미분류). 기존 배치를
 *  전부 대체하는 "이동" 의미 — 목록 드래그·일괄 이동이 쓴다. */
export async function setMountFolder({ reportId, workspaceSlug, folderId }) {
  const res = await apiClient.put(
    `${BASE}/${reportId}/${workspaceSlug}/folder`,
    { folder_id: folderId },
  )
  return extractData(res)
}

/** 이 게시판에서의 폴더 배치 **집합**을 통째로 치환 — 한 게시판의 여러
 *  폴더에 동시에 걸 때. 빈 배열 = 미분류. */
export async function setMountFolders({ reportId, workspaceSlug, folderIds }) {
  const res = await apiClient.put(
    `${BASE}/${reportId}/${workspaceSlug}/folders`,
    { folder_ids: folderIds ?? [] },
  )
  return extractData(res)
}

/** Change a mount's edit policy. Owner-only (server-enforced).
 *  Valid values: 'default', 'owner_only', 'coauthor'. */
export async function setMountEditPolicy({ reportId, workspaceSlug, editPolicy }) {
  const res = await apiClient.put(
    `${BASE}/${reportId}/${workspaceSlug}/edit-policy`,
    { edit_policy: editPolicy },
  )
  return extractData(res)
}

/** 게시 메모 수정. 권한: 작성자 / 게시자 / 게시판 매니저(서버 강제). */
export async function setMountNote({ reportId, workspaceSlug, note }) {
  const res = await apiClient.put(
    `${BASE}/${reportId}/${workspaceSlug}/note`,
    { note: note ?? '' },
  )
  return extractData(res)
}

/** Unmount from one specific board. Idempotent. */
export async function unmountReport({ reportId, workspaceSlug }) {
  const res = await apiClient.delete(`${BASE}/${reportId}/${workspaceSlug}`)
  return extractData(res)
}
