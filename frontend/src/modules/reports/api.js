import { apiClient, extractData } from '@/shared/api/client'

const BASE = '/api/reports'

export async function listReports() {
  const res = await apiClient.get(BASE)
  return extractData(res)
}

export async function getReport(id) {
  const res = await apiClient.get(`${BASE}/${id}`)
  return extractData(res)
}

export async function createReport(payload) {
  const res = await apiClient.post(BASE, payload)
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
