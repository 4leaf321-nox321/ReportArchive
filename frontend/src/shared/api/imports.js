import { apiClient, extractData } from './client'

/**
 * PPTX 파일을 업로드해 휴리스틱 변환된 새 보고서 초안을 만든다.
 * 반환: { id, workspace_slug, warnings }. 파싱이 느릴 수 있어 타임아웃 넉넉히.
 */
export async function importPptx(file, { onProgress } = {}) {
  const form = new FormData()
  form.append('file', file)
  const res = await apiClient.post('/api/imports/pptx', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 600000,
    onUploadProgress: onProgress
      ? (e) => {
          if (e.total) onProgress(e.loaded / e.total)
        }
      : undefined,
  })
  return extractData(res)
}
