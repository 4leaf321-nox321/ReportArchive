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
