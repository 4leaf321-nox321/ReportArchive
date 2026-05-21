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
