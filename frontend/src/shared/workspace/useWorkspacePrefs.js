import * as React from 'react'
import { useAuth } from '@/shared/auth/AuthContext'

/**
 * Per-user workspace preferences:
 *   - pinned: explicitly favorited slugs (user-controlled order)
 *   - recent: recently visited slugs (most recent first, max RECENT_LIMIT)
 *
 * `pinned`(즐겨찾기) lives in the server-side user profile
 * (me.preferences.workspace.pinned) so favorites follow the user across
 * browsers/devices — Edge 에서 별표한 부서가 Chrome 에서도 보인다.
 *
 * `recent` 는 "이 브라우저의 마지막 컨텍스트" 성격이고 부서를 옮길 때마다
 * 갱신되므로(서버 왕복을 매번 일으킬 필요가 없어) 그대로 localStorage 에 둔다.
 */
const STORAGE_KEY = 'ra:workspace-prefs:v1'
const RECENT_LIMIT = 8

function loadRecent() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.recent) ? parsed.recent : []
  } catch {
    return []
  }
}

function saveRecent(recent) {
  try {
    // 기존 객체의 다른 필드(레거시 pinned 포함)를 보존한 채 recent 만 갱신 —
    // 아직 서버로 마이그레이션되기 전인 레거시 pinned 를 덮어쓰지 않도록.
    const raw = localStorage.getItem(STORAGE_KEY)
    const prev = raw ? JSON.parse(raw) : {}
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...prev, recent }))
  } catch {
    // localStorage unavailable (private mode, quota) — ignore.
  }
}

/** 레거시 localStorage 에 남아 있던 즐겨찾기(서버 도입 이전) — 1회 이관용. */
function loadLegacyPinned() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.pinned) ? parsed.pinned : []
  } catch {
    return []
  }
}

export function useWorkspacePrefs() {
  const { me, updatePreferences } = useAuth()

  const [recent, setRecent] = React.useState(loadRecent)

  // 서버 저장값 — me.preferences.workspace.pinned. 로그인 전/로딩 중엔 빈 배열.
  const serverPinned = me?.preferences?.workspace?.pinned
  const pinned = React.useMemo(
    () => (Array.isArray(serverPinned) ? serverPinned : []),
    [serverPinned],
  )

  // 동기적으로 연속 호출되는 togglePin 이 최신 목록을 보도록 ref 로 미러링 —
  // 두 개를 빠르게 토글할 때 한쪽이 다른 쪽의 낙관적 갱신을 덮어쓰는 레이스 방지.
  const pinnedRef = React.useRef(pinned)
  pinnedRef.current = pinned

  // 1회 마이그레이션 — 서버에 즐겨찾기 기록이 아직 없고(undefined) 이 브라우저
  // localStorage 에 레거시 즐겨찾기가 있으면 그것으로 서버를 시드한다.
  const migratedRef = React.useRef(false)
  React.useEffect(() => {
    if (!me || migratedRef.current) return
    migratedRef.current = true
    // 서버에 이미 배열이 있으면(빈 배열 포함) 이관 불필요.
    if (Array.isArray(serverPinned)) return
    const legacy = loadLegacyPinned()
    if (legacy.length) {
      updatePreferences?.({ workspace: { pinned: legacy } })
    }
  }, [me, serverPinned, updatePreferences])

  const togglePin = React.useCallback(
    (slug) => {
      const current = pinnedRef.current
      const next = current.includes(slug)
        ? current.filter((s) => s !== slug)
        : [...current, slug]
      // 다음 렌더 전에 동기 후속 토글이 최신값을 보도록 즉시 반영.
      pinnedRef.current = next
      // updatePreferences 가 로컬 me.preferences 를 낙관적으로 갱신 + 서버 PATCH.
      // 배열은 깊은 병합 대신 통째로 교체되므로 전체 목록을 보낸다.
      updatePreferences?.({ workspace: { pinned: next } })
    },
    [updatePreferences],
  )

  const pushRecent = React.useCallback((slug) => {
    setRecent((prev) => {
      const next = [slug, ...prev.filter((s) => s !== slug)].slice(0, RECENT_LIMIT)
      saveRecent(next)
      return next
    })
  }, [])

  const isPinned = React.useCallback((slug) => pinned.includes(slug), [pinned])

  return { pinned, recent, togglePin, pushRecent, isPinned }
}
