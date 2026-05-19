/**
 * useReportLock — orchestrates the report edit-lock lifecycle.
 *
 * Imperative API on purpose: the caller decides when to enter edit mode
 * (`acquire()`), how to react when the lock is held by someone else (catch
 * LockConflictError with code='lock_held_by_other' and re-try with
 * force=true), and when to drop it (`release()` on save / cancel / leave).
 *
 * The hook handles two things automatically once a lock is held:
 *   1. periodic heartbeat to keep the lock alive
 *   2. best-effort release on page unload (fetch with keepalive=true,
 *      since the standard axios DELETE wouldn't survive a tab close)
 *
 * If a heartbeat ever fails (typically lock_not_held after a forced
 * takeover), `onLost` is invoked exactly once — the caller is expected
 * to bail out of edit mode and surface a toast.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  acquireReportLock,
  heartbeatReportLock,
  releaseReportLock,
  LockConflictError,
} from './api'
import { getAccessToken } from '@/shared/api/client'

const HEARTBEAT_INTERVAL_MS = 30_000

export function useReportLock(reportId, { onLost } = {}) {
  const [holder, setHolder] = useState(null)
  const [isHeld, setIsHeld] = useState(false)
  // Ref mirror so the heartbeat interval / unmount cleanup can read the
  // latest state without re-binding on every render.
  const isHeldRef = useRef(false)
  const reportIdRef = useRef(reportId)
  const onLostRef = useRef(onLost)
  useEffect(() => { reportIdRef.current = reportId }, [reportId])
  useEffect(() => { onLostRef.current = onLost }, [onLost])
  useEffect(() => { isHeldRef.current = isHeld }, [isHeld])

  const acquire = useCallback(
    async ({ force = false } = {}) => {
      if (!reportId) throw new Error('useReportLock: reportId is required')
      const info = await acquireReportLock(reportId, { force })
      setHolder(info)
      setIsHeld(true)
      return info
    },
    [reportId],
  )

  const release = useCallback(async () => {
    if (!reportId) return
    // Mark released *before* the network call so a stray heartbeat tick
    // doesn't fire mid-release.
    setIsHeld(false)
    setHolder(null)
    await releaseReportLock(reportId)
  }, [reportId])

  // Heartbeat — keeps the lock alive while held. Fires every 30s; one
  // missed beat is fine (TTL is 120s), but if the request comes back
  // 409/lock_not_held we bail out and call onLost so the page can exit
  // edit mode immediately rather than waiting for the next save.
  useEffect(() => {
    if (!isHeld || !reportId) return
    let cancelled = false
    const id = setInterval(async () => {
      if (cancelled) return
      try {
        const info = await heartbeatReportLock(reportId)
        if (!cancelled) setHolder(info)
      } catch (err) {
        if (cancelled) return
        if (err instanceof LockConflictError) {
          setIsHeld(false)
          setHolder(null)
          onLostRef.current?.(err)
        }
        // Network/5xx — keep the lock state and let the next tick retry.
        // TTL gives us 4x margin (4 heartbeats) before the server drops us.
      }
    }, HEARTBEAT_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [isHeld, reportId])

  // Best-effort release when the tab closes. The component unmount path
  // can use the regular axios DELETE; this handles the cases (tab close,
  // browser quit) where unmount cleanup never runs.
  useEffect(() => {
    if (!isHeld || !reportId) return
    const handler = () => {
      // fetch with keepalive survives a tab close where axios would not.
      // Auth + workspace headers are inlined because the apiClient
      // interceptor only runs for its own instance.
      const token = getAccessToken()
      try {
        const baseURL = import.meta.env.VITE_API_BASE_URL || ''
        fetch(`${baseURL}/api/reports/${reportId}/lock`, {
          method: 'DELETE',
          keepalive: true,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }).catch(() => {})
      } catch {
        /* best-effort — server's TTL will reclaim eventually */
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isHeld, reportId])

  // Unmount: drop the lock so navigating to another page doesn't leave
  // a stale row blocking the next editor for the full TTL.
  useEffect(() => {
    return () => {
      if (isHeldRef.current && reportIdRef.current) {
        releaseReportLock(reportIdRef.current).catch(() => {})
      }
    }
  }, [])

  return { acquire, release, isHeld, holder }
}
