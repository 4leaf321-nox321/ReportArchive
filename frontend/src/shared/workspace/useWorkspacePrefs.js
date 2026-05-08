import * as React from 'react'

/**
 * Per-user (per-browser) workspace preferences:
 *   - pinned: explicitly favorited slugs (user-controlled order)
 *   - recent: recently visited slugs (most recent first, max RECENT_LIMIT)
 *
 * Persisted to localStorage. When auth is wired up, this should move into
 * the user profile so prefs follow the user across devices.
 */
const STORAGE_KEY = 'ra:workspace-prefs:v1'
const RECENT_LIMIT = 8

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { pinned: [], recent: [] }
    const parsed = JSON.parse(raw)
    return {
      pinned: Array.isArray(parsed.pinned) ? parsed.pinned : [],
      recent: Array.isArray(parsed.recent) ? parsed.recent : [],
    }
  } catch {
    return { pinned: [], recent: [] }
  }
}

function save(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // localStorage unavailable (private mode, quota) — ignore.
  }
}

export function useWorkspacePrefs() {
  const [prefs, setPrefs] = React.useState(load)

  const togglePin = React.useCallback((slug) => {
    setPrefs((prev) => {
      const next = prev.pinned.includes(slug)
        ? { ...prev, pinned: prev.pinned.filter((s) => s !== slug) }
        : { ...prev, pinned: [...prev.pinned, slug] }
      save(next)
      return next
    })
  }, [])

  const pushRecent = React.useCallback((slug) => {
    setPrefs((prev) => {
      const recent = [slug, ...prev.recent.filter((s) => s !== slug)].slice(0, RECENT_LIMIT)
      const next = { ...prev, recent }
      save(next)
      return next
    })
  }, [])

  const isPinned = React.useCallback((slug) => prefs.pinned.includes(slug), [prefs.pinned])

  return { pinned: prefs.pinned, recent: prefs.recent, togglePin, pushRecent, isPinned }
}
