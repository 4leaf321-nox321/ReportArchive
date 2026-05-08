import * as React from 'react'

/**
 * useState backed by localStorage. Useful for UI prefs like panel open state,
 * theme, recent searches, etc. Falls back to initial value if storage is
 * unavailable (private mode, quota) or the stored value can't be parsed.
 *
 *   const [open, setOpen] = usePersistedState('ra:ai-dock-open:v1', true)
 */
export function usePersistedState(key, initial) {
  const [value, setValue] = React.useState(() => {
    if (typeof window === 'undefined') return initial
    try {
      const raw = localStorage.getItem(key)
      if (raw == null) return initial
      return JSON.parse(raw)
    } catch {
      return initial
    }
  })

  React.useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* ignore */
    }
  }, [key, value])

  return [value, setValue]
}
