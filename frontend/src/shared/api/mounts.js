import { apiClient, extractData } from './client'

const BASE = '/api/mounts'

/** List every org board this report is mounted on. */
export async function listMounts(reportId) {
  const res = await apiClient.get(BASE, { params: { report_id: reportId } })
  const data = extractData(res)
  return data?.items ?? []
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
}) {
  const res = await apiClient.post(BASE, {
    report_id: reportId,
    workspace_slugs: workspaceSlugs,
    edit_policy: editPolicy,
    note,
    folder_id: folderId,
  })
  const data = extractData(res)
  return data?.items ?? []
}

/** Move an existing mount between org folders (or null = 미분류). */
export async function setMountFolder({ reportId, workspaceSlug, folderId }) {
  const res = await apiClient.put(
    `${BASE}/${reportId}/${workspaceSlug}/folder`,
    { folder_id: folderId },
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
