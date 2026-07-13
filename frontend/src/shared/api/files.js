import { apiClient, extractData, getAccessToken } from './client'

const BASE = '/api/files'

/**
 * Uploads a file via multipart/form-data.
 * Returns FileMeta: { id, filename, mime_type, size, is_image, ... }.
 *
 * Optional onProgress callback receives a number 0..1.
 */
export async function uploadFile(file, { onProgress } = {}) {
  const form = new FormData()
  form.append('file', file)
  const res = await apiClient.post(BASE, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: onProgress
      ? (e) => {
          if (e.total) onProgress(e.loaded / e.total)
        }
      : undefined,
  })
  return extractData(res)
}

export async function getFileMeta(fileId) {
  const res = await apiClient.get(`${BASE}/${fileId}/meta`)
  return extractData(res)
}

export async function deleteFile(fileId) {
  const res = await apiClient.delete(`${BASE}/${fileId}`)
  return extractData(res)
}

/** 시스템관리자 — 한 부서가 소유한 파일 목록 + 참조 정보(어느 보고서가 쓰는지).
 *  부서 삭제/개편 정리용(조직개편·계정삭제_설계.md 후속). */
export async function listWorkspaceFiles(slug) {
  const res = await apiClient.get(`${BASE}/workspace/${slug}`)
  return extractData(res)
}

/** 시스템관리자 — 파일 일괄 삭제(디스크+DB). 살아있는 보고서가 참조하는 파일을
 *  지우면 그 보고서의 이미지/첨부가 깨진다. */
export async function bulkDeleteFiles(fileIds) {
  const res = await apiClient.post(`${BASE}/bulk-delete`, { file_ids: fileIds })
  return extractData(res)
}

/** 시스템관리자 — 파일들을 다른 부서로 이관(자료 보존). 부서 병합/이동 시 사용. */
export async function reassignFiles(fileIds, targetSlug) {
  const res = await apiClient.post(`${BASE}/reassign`, {
    file_ids: fileIds,
    target_slug: targetSlug,
  })
  return extractData(res)
}

/**
 * Returns a URL that can be set on `<img src>` or `<a href>`.
 *
 * Browsers can't attach our `Authorization` header to <img> requests, so
 * we embed the token in the query string for plain-link rendering. The
 * backend doesn't read tokens from the query string today — for now,
 * use authedDownload() below for downloads, and renderImageElement() for
 * images. URLs from this helper are placeholders for future signed-URL
 * support.
 */
export function fileApiUrl(fileId) {
  const baseURL = apiClient.defaults.baseURL || ''
  return `${baseURL}${BASE}/${fileId}`
}

/**
 * Returns a blob: URL for an authenticated image. Caller is responsible
 * for releasing it via URL.revokeObjectURL() when no longer needed.
 */
export async function fetchImageObjectURL(fileId) {
  const res = await apiClient.get(`${BASE}/${fileId}`, { responseType: 'blob' })
  return URL.createObjectURL(res.data)
}

/**
 * Returns the raw Blob for an authenticated file. Used by callers that
 * want to feed the bytes directly into a loader (Three.js, KaTeX, etc.)
 * without going through an object URL — avoids leaking URL-table
 * entries and makes ArrayBuffer access via blob.arrayBuffer() trivial.
 */
export async function fetchFileBlob(fileId) {
  const res = await apiClient.get(`${BASE}/${fileId}`, { responseType: 'blob' })
  return res.data
}

/**
 * Downloads a file by streaming it as a blob and triggering a save dialog.
 * Used by the attachment widget — keeps the auth header attached.
 */
export async function downloadFile(fileId, suggestedFilename) {
  const res = await apiClient.get(`${BASE}/${fileId}`, { responseType: 'blob' })
  const url = URL.createObjectURL(res.data)
  const a = document.createElement('a')
  a.href = url
  a.download = suggestedFilename || 'download'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

// re-export so consumers can read the token if they need to roll their own URL
export { getAccessToken }
