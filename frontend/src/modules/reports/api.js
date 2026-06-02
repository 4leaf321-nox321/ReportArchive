import { apiClient, extractData } from '@/shared/api/client'

const BASE = '/api/reports'

export async function listReports({ entityIds, folderId, includePublic } = {}) {
  // Build via URLSearchParams instead of axios's default params object:
  // axios 1.x serializes arrays as `entity_ids[]=1&entity_ids[]=2`, but
  // FastAPI's `Query(default=None)` over `list[int]` expects repeated
  // keys with no brackets (`entity_ids=1&entity_ids=2`). URLSearchParams'
  // append() produces exactly that form.
  const params = new URLSearchParams()
  if (Array.isArray(entityIds)) {
    for (const id of entityIds) params.append('entity_ids', String(id))
  }
  if (folderId !== undefined && folderId !== null && folderId !== '') {
    // folderId can be an integer or the special "uncategorized" string —
    // backend handles the dispatch.
    params.append('folder_id', String(folderId))
  }
  // 조직 간 공개 탐색(opt-in) — org 컨텍스트에서만 의미. 기본 목록은 안 보냄.
  if (includePublic) params.append('include_public', 'true')
  const qs = params.toString()
  const res = await apiClient.get(qs ? `${BASE}?${qs}` : BASE)
  return extractData(res)
}

export async function getReport(id) {
  const res = await apiClient.get(`${BASE}/${id}`)
  return extractData(res)
}

/** Metadata-only folder placement — no lock required. Owner-only. */
export async function moveReportToFolder(id, folderId) {
  const res = await apiClient.put(`${BASE}/${id}/folder`, {
    folder_id: folderId,
  })
  return extractData(res)
}

/** Owner-only: phase → finalized. */
export async function publishReport(id) {
  const res = await apiClient.post(`${BASE}/${id}/publish`)
  return extractData(res)
}

/** Owner-only: finalized → drafting. */
export async function unpublishReport(id) {
  const res = await apiClient.post(`${BASE}/${id}/unpublish`)
  return extractData(res)
}

/** Toggle author hard lock. Owner only (system admin can force-unset). */
export async function setAuthorLock(id, { enabled, reason }) {
  const res = await apiClient.put(`${BASE}/${id}/author-lock`, {
    enabled,
    reason: reason ?? '',
  })
  return extractData(res)
}

export async function createReport(payload) {
  const res = await apiClient.post(BASE, payload)
  return extractData(res)
}

/** Duplicate an existing report into the caller's personal space.
 *  `mode`: 'content' (본문+표시설정만) | 'full' (메타·연결까지). The server
 *  decides exactly what travels — see backend ReportCopy / copy_report. */
export async function copyReport(sourceId, { title, folder_id = null, mode = 'full' }) {
  const res = await apiClient.post(`${BASE}/${sourceId}/copy`, {
    title,
    folder_id,
    mode,
  })
  return extractData(res)
}

export async function updateReport(id, payload) {
  try {
    const res = await apiClient.patch(`${BASE}/${id}`, payload)
    return extractData(res)
  } catch (err) {
    _maybeThrowLockError(err)
    throw err
  }
}

export async function deleteReport(id) {
  const res = await apiClient.delete(`${BASE}/${id}`)
  return extractData(res)
}

// --------------------------------------------------------------------- //
// Edit-lock endpoints                                                   //
//                                                                       //
// The three calls below mirror POST/POST-heartbeat/DELETE on the same   //
// path. They re-throw the raw axios error after annotating it with the  //
// backend's `code` string so callers can dispatch on it (e.g.           //
// lock_held_by_other → takeover dialog, lock_not_held → exit edit mode, //
// revision_mismatch → reload prompt) without re-parsing the envelope.   //
// --------------------------------------------------------------------- //

export class LockConflictError extends Error {
  constructor({ code, message, holder }) {
    super(message || 'Lock conflict')
    this.name = 'LockConflictError'
    this.code = code || 'lock_error'
    this.holder = holder ?? null
  }
}

function _maybeThrowLockError(err) {
  // The standard error envelope is `{success:false, message, errors:[...]}`.
  // For 409s, errors[0] carries our structured lock payload.
  if (err?.response?.status !== 409) return
  const detail = err.response.data?.errors?.[0]
  if (!detail || typeof detail !== 'object' || !detail.code) return
  throw new LockConflictError(detail)
}

export async function acquireReportLock(id, { force = false } = {}) {
  try {
    const res = await apiClient.post(
      `${BASE}/${id}/lock`,
      null,
      { params: force ? { force: true } : undefined },
    )
    return extractData(res)
  } catch (err) {
    _maybeThrowLockError(err)
    throw err
  }
}

export async function heartbeatReportLock(id) {
  try {
    const res = await apiClient.post(`${BASE}/${id}/lock/heartbeat`)
    return extractData(res)
  } catch (err) {
    _maybeThrowLockError(err)
    throw err
  }
}

export async function releaseReportLock(id) {
  try {
    const res = await apiClient.delete(`${BASE}/${id}/lock`)
    return extractData(res)
  } catch (err) {
    // Release is best-effort — even a 4xx shouldn't propagate; the
    // server-side TTL will reclaim the lock anyway.
    return null
  }
}
