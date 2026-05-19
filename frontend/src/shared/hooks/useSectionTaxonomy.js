import * as React from 'react'
import { listSectionCategories } from '@/shared/api/sectionTaxonomy'

/**
 * Section taxonomy (단락 구분) cache — modeled on useWidgetRelations.
 * The picker, the per-widget badge resolver, and the admin page all
 * share this single fetch; admin mutations call `invalidate…Cache()`
 * after writes so the next read pulls fresh data.
 *
 * Returns:
 *   { categories, itemByCode, loading, error, reload }
 *
 *   - categories: ordered list of { slug, name, color, sort_order,
 *                                   items: [{ code, label, en, ... }] }
 *   - itemByCode: { [code]: { item, category } } — fast lookup for the
 *                 BlockEditorCard badge + picker pre-selection.
 */
let cachedPromise = null

function buildIndex(categories) {
  const list = Array.isArray(categories) ? categories : []
  const itemByCode = {}
  for (const cat of list) {
    for (const item of cat.items ?? []) {
      itemByCode[item.code] = { item, category: cat }
    }
  }
  return { list, itemByCode }
}

function loadTaxonomy() {
  if (!cachedPromise) {
    cachedPromise = listSectionCategories()
      .then(buildIndex)
      .catch((err) => {
        cachedPromise = null
        throw err
      })
  }
  return cachedPromise
}

export function invalidateSectionTaxonomyCache() {
  cachedPromise = null
}

export function useSectionTaxonomy() {
  const [state, setState] = React.useState({
    categories: [],
    itemByCode: {},
    loading: true,
    error: null,
  })

  const run = React.useCallback(() => {
    let cancelled = false
    loadTaxonomy()
      .then(({ list, itemByCode }) => {
        if (!cancelled) {
          setState({
            categories: list,
            itemByCode,
            loading: false,
            error: null,
          })
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ categories: [], itemByCode: {}, loading: false, error })
        }
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
    invalidateSectionTaxonomyCache()
    setState((s) => ({ ...s, loading: true }))
    run()
  }, [run])

  return { ...state, reload }
}
