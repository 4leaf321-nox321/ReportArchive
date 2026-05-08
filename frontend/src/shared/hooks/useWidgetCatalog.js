import * as React from 'react'
import { fetchWidgetCatalog } from '@/shared/api/widgets'

/**
 * The widget catalog is static for the life of a session — fetch once,
 * cache in module scope. Components mount frequently (each TemplateEditor
 * open) but the answer never changes.
 *
 * Returns { catalog, loading, error } where catalog is:
 *   { schema_version, widgets: [...], byType: { [type]: widget } }
 */
let cachedPromise = null

function loadCatalog() {
  if (!cachedPromise) {
    cachedPromise = fetchWidgetCatalog()
      .then((data) => {
        const byType = Object.fromEntries((data.widgets ?? []).map((w) => [w.type, w]))
        return { ...data, byType }
      })
      .catch((err) => {
        // Don't memoize failures — let the next caller retry.
        cachedPromise = null
        throw err
      })
  }
  return cachedPromise
}

export function useWidgetCatalog() {
  const [state, setState] = React.useState({ catalog: null, loading: true, error: null })

  React.useEffect(() => {
    let cancelled = false
    loadCatalog()
      .then((catalog) => {
        if (!cancelled) setState({ catalog, loading: false, error: null })
      })
      .catch((error) => {
        if (!cancelled) setState({ catalog: null, loading: false, error })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
