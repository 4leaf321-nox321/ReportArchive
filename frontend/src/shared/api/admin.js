import { apiClient, extractData } from './client'

const BASE = '/api/admin'

/**
 * Disk + per-workspace storage footprint. Admin-only.
 * Returns:
 *   {
 *     partition: { path, total_bytes, used_bytes, free_bytes, percent_used },
 *     upload_dir: { path, size_bytes, file_count },
 *     by_workspace: [{ workspace_slug, workspace_name, size_bytes, file_count }],
 *     safety_margin_bytes,
 *     upload_max_bytes,
 *   }
 */
export async function getStorageStats() {
  const res = await apiClient.get(`${BASE}/storage`)
  return extractData(res)
}

/**
 * Server spec snapshot — OS / CPU / memory / runtime / DB. Admin-only.
 * Returns:
 *   {
 *     host:    { hostname, os, kernel, arch, uptime_seconds },
 *     cpu:     { model, physical_sockets, logical_cpus,
 *                load_avg_1m, load_avg_5m, load_avg_15m },
 *     memory:  { total_bytes, available_bytes, used_bytes, percent_used },
 *     process: { pid, rss_bytes, python_version },
 *     runtime: { uvicorn_workers, app_env, serve_frontend_dist },
 *     database:{ version, pool: { size, checkedout, checkedin, overflow } },
 *   }
 */
export async function getServerInfo() {
  const res = await apiClient.get(`${BASE}/server-info`)
  return extractData(res)
}

/**
 * Tunable runtime settings (uvicorn workers, DB pool). Admin-only.
 * GET returns per-key {stored, effective, limits, updated_at, restart_required}.
 * PUT upserts a single (key, value) pair and returns the refreshed view.
 */
export async function getRuntimeTuning() {
  const res = await apiClient.get(`${BASE}/runtime-tuning`)
  return extractData(res)
}

export async function setRuntimeTuning(key, value) {
  const res = await apiClient.put(`${BASE}/runtime-tuning`, { key, value })
  return extractData(res)
}

/**
 * 어느 보고서·종합보고에서도 참조하지 않는 업로드 파일(오펀) 목록. Admin-only.
 * Returns: {
 *   items: [{id, filename, mime_type, size, owner_user_id, workspace_slug, uploaded_at}],
 *   total_count, total_size, referenced_count, grace_protected, grace_hours, has_versions
 * }
 */
export async function listOrphanFiles({ graceHours = 48 } = {}) {
  const res = await apiClient.get(`${BASE}/orphan-files`, {
    params: { grace_hours: graceHours },
  })
  return extractData(res)
}

/**
 * 선택한 오펀 파일 삭제(디스크+DB). 삭제 직전 서버가 다시 검증해 그 사이 참조됐거나
 * 유예 안인 파일은 건너뛴다. Returns: { deleted, freed_bytes, skipped: [{id, reason}] }
 */
export async function deleteOrphanFiles(fileIds, { graceHours = 48 } = {}) {
  const res = await apiClient.post(`${BASE}/orphan-files/delete`, {
    file_ids: fileIds,
    grace_hours: graceHours,
  })
  return extractData(res)
}
