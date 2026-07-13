// HTML 임베드 번들 API (HTML임베드_번들_설계.md) — 폴더(메인 HTML + 서브 파일)를
// 구조 그대로 올리고, 불투명 bundle_id 로 sandbox iframe 에 서빙받는다.
import { apiClient, extractData } from './client'

/**
 * 폴더 번들 생성. 각 파일은 multipart filename 에 *상대경로* 를 실어 보낸다
 * (FormData.append 의 3번째 인자) → 백엔드가 그 경로로 폴더 구조를 복원한다.
 *
 * @param {Array<{file: File, path: string}>} entries  업로드 파일 + 상대경로
 * @param {string} entryPath  메인(첫 화면) HTML 의 상대경로
 * @param {{onProgress?: (p:number)=>void}} [opts]
 * @returns {Promise<{id,entry_path,file_count,total_bytes,...}>}  BundleMeta
 */
export async function createEmbedBundle(entries, entryPath, { onProgress } = {}) {
  const form = new FormData()
  for (const { file, path } of entries) {
    // 3번째 인자(filename)에 상대경로 → 서버 UploadFile.filename == 상대경로.
    form.append('files', file, path)
  }
  form.append('entry_path', entryPath)
  const res = await apiClient.post('/api/embed', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: onProgress
      ? (e) => {
          if (e.total) onProgress(e.loaded / e.total)
        }
      : undefined,
  })
  return extractData(res)
}

/**
 * 번들 파일의 서빙 URL. **상대경로**(같은 origin) 로 조립한다 — IP/도메인에
 * 안 묶이게(HTML임베드_번들_설계.md §10). iframe 이 이 URL 을 직접 로드하므로
 * apiClient 의 Authorization 헤더는 안 실린다(서빙은 capability=bundle_id 기반).
 */
export function embedBundleUrl(bundleId, relPath) {
  const base = apiClient.defaults.baseURL || ''
  const clean = String(relPath || '').replace(/^\/+/, '')
  return `${base}/api/embed/${bundleId}/${clean}`
}

export async function deleteEmbedBundle(bundleId) {
  const res = await apiClient.delete(`/api/embed/${bundleId}`)
  return extractData(res)
}

/** 시스템관리자 — 한 부서가 소유한 임베드 번들 목록 + 참조 정보(부서 삭제/개편 정리용). */
export async function listWorkspaceBundles(slug) {
  const res = await apiClient.get(`/api/embed/workspace/${slug}`)
  return extractData(res)
}

/** 시스템관리자 — 임베드 번들 일괄 삭제(디스크 폴더+DB). */
export async function bulkDeleteBundles(bundleIds) {
  const res = await apiClient.post('/api/embed/bulk-delete', { bundle_ids: bundleIds })
  return extractData(res)
}

/** 시스템관리자 — 번들들을 다른 부서로 이관(자료 보존). */
export async function reassignBundles(bundleIds, targetSlug) {
  const res = await apiClient.post('/api/embed/reassign', {
    bundle_ids: bundleIds,
    target_slug: targetSlug,
  })
  return extractData(res)
}
