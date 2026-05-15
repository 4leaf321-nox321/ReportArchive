import * as React from 'react'
import { listWidgetRelations } from '@/shared/api/widgetRelations'

/**
 * Cache the widget-relations list for the lifetime of the session.
 * Used by every RichText outline editor — `bumpCache()` lets the admin
 * page invalidate after add/edit/delete without a page reload.
 *
 * Returns { relations, byKey, loading, error, reload }.
 */
let cachedPromise = null

function loadRelations() {
  if (!cachedPromise) {
    cachedPromise = listWidgetRelations()
      .then((items) => {
        const list = Array.isArray(items) ? items : []
        const byKey = Object.fromEntries(list.map((r) => [r.slug, r]))
        return { list, byKey }
      })
      .catch((err) => {
        cachedPromise = null
        throw err
      })
  }
  return cachedPromise
}

export function invalidateWidgetRelationsCache() {
  cachedPromise = null
}

export function useWidgetRelations() {
  const [state, setState] = React.useState({
    relations: [],
    byKey: {},
    loading: true,
    error: null,
  })

  const run = React.useCallback(() => {
    let cancelled = false
    loadRelations()
      .then(({ list, byKey }) => {
        if (!cancelled) {
          setState({ relations: list, byKey, loading: false, error: null })
        }
      })
      .catch((error) => {
        if (!cancelled) setState({ relations: [], byKey: {}, loading: false, error })
      })
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    const cancel = run()
    return cancel
  }, [run])

  const reload = React.useCallback(() => {
    invalidateWidgetRelationsCache()
    setState((s) => ({ ...s, loading: true }))
    run()
  }, [run])

  return { ...state, reload }
}
