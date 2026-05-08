import * as React from 'react'

/**
 * Tiny "fetch on mount + when deps change" hook. Avoids pulling in a full
 * data layer (React Query / SWR) before we know the access patterns.
 *
 * Returns { data, loading, error, reload }.
 *
 *   const { data, loading, error, reload } = useAsync(() => listReports(), [slug])
 */
export function useAsync(fn, deps = []) {
  const [state, setState] = React.useState({ data: null, loading: true, error: null })
  const [tick, setTick] = React.useState(0)
  const reload = React.useCallback(() => setTick((t) => t + 1), [])

  React.useEffect(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))
    Promise.resolve()
      .then(() => fn())
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null })
      })
      .catch((error) => {
        if (!cancelled) setState({ data: null, loading: false, error })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  return { ...state, reload }
}
