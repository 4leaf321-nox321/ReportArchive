import * as React from 'react'
import { useLocation, useNavigate, matchPath } from 'react-router-dom'
import { setCurrentWorkspace } from '@/shared/api/client'
import { listWorkspaces } from '@/shared/api/workspaces'
import { useAuth } from '@/shared/auth/AuthContext'
import { useWorkspacePrefs } from './useWorkspacePrefs'

const WorkspaceContext = React.createContext(null)

const DEFAULT_FALLBACK = 'dev'

/**
 * Loads the workspace registry from the backend, derives the active slug
 * from the URL (matchPath on /w/:workspace/*), and propagates it to the
 * API client header.
 *
 * If workspaces haven't loaded yet, falls back to a sentinel until they do —
 * the AppShell renders a thin loading state during the first fetch.
 */
export function WorkspaceProvider({ children }) {
  const location = useLocation()
  const navigate = useNavigate()
  const prefs = useWorkspacePrefs()
  const { me, refresh: refreshAuth } = useAuth()

  const [all, setAll] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(null)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    listWorkspaces()
      .then((data) => {
        if (!cancelled) setAll(data || [])
      })
      .catch((err) => {
        if (!cancelled) setError(err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const slugMap = React.useMemo(() => {
    const m = new Map()
    for (const w of all) m.set(w.slug, w)
    return m
  }, [all])

  const match = matchPath({ path: '/w/:workspace/*' }, location.pathname)
  const requestedSlug = match?.params?.workspace

  // Fallback ordering when the URL has no /w/:slug (e.g. /profile, /templates):
  //   1. The user's first membership — almost always what they want.
  //   2. DEFAULT_FALLBACK (= 'dev') if it exists in the registry.
  //   3. Any non-virtual root workspace as a last resort.
  // We don't want a manager-of-biz-marketing to default into 'dev' and then
  // hit 403 walls on every API call.
  const userFirstSlug = me?.memberships?.[0]?.workspace_slug
  const fallbackSlug =
    (userFirstSlug && slugMap.has(userFirstSlug) && userFirstSlug) ||
    (slugMap.has(DEFAULT_FALLBACK) && DEFAULT_FALLBACK) ||
    all.find((w) => !w.virtual && w.parent_slug === null)?.slug

  const slug = requestedSlug && slugMap.has(requestedSlug) ? requestedSlug : fallbackSlug
  const workspace = slug ? slugMap.get(slug) : null

  // Sync header for outgoing requests + track recent visits + re-resolve
  // the user's role on the new workspace. /api/me returns role=null when no
  // X-Workspace-Slug header is present, so we re-fetch once the slug is set.
  React.useEffect(() => {
    if (workspace) {
      setCurrentWorkspace(workspace.slug)
      prefs.pushRecent(workspace.slug)
      // Fire-and-forget — auth context will update `me` when it returns.
      refreshAuth()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.slug])

  const switchWorkspace = React.useCallback(
    (nextSlug) => {
      navigate(`/w/${nextSlug}`)
    },
    [navigate]
  )

  // Tree helpers — kept here so the provider is the single source of truth.
  const helpers = React.useMemo(() => makeHelpers(all), [all])

  const value = React.useMemo(
    () => ({
      workspace,
      slug: workspace?.slug,
      all,
      loading,
      error,
      switchWorkspace,
      prefs,
      ...helpers,
    }),
    [workspace, all, loading, error, switchWorkspace, prefs, helpers]
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace() {
  const ctx = React.useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace must be used inside WorkspaceProvider')
  return ctx
}

function makeHelpers(all) {
  const byParent = new Map()
  for (const w of all) {
    const arr = byParent.get(w.parent_slug) ?? []
    arr.push(w)
    byParent.set(w.parent_slug, arr)
  }
  const slugMap = new Map(all.map((w) => [w.slug, w]))

  function getChildren(slug) {
    return byParent.get(slug) ?? []
  }

  function getDescendantsInclusive(slug) {
    const out = []
    const stack = [slug]
    while (stack.length) {
      const cur = stack.pop()
      if (!slugMap.has(cur)) continue
      out.push(cur)
      for (const c of getChildren(cur)) stack.push(c.slug)
    }
    return out
  }

  function getAncestors(slug) {
    const path = []
    let cur = slugMap.get(slug)?.parent_slug ?? null
    while (cur) {
      const node = slugMap.get(cur)
      if (!node) break
      path.unshift(node)
      cur = node.parent_slug
    }
    return path
  }

  function getPath(slug) {
    const node = slugMap.get(slug)
    if (!node) return []
    return [...getAncestors(slug), node]
  }

  function buildTree({ includeVirtual = false } = {}) {
    function attach(node, depth) {
      return {
        ...node,
        depth,
        children: getChildren(node.slug)
          .filter((c) => includeVirtual || !c.virtual)
          .map((c) => attach(c, depth + 1)),
      }
    }
    return all
      .filter((w) => w.parent_slug === null && (includeVirtual || !w.virtual))
      .map((w) => attach(w, 0))
  }

  function flattenTree(tree) {
    const out = []
    function walk(nodes) {
      for (const n of nodes) {
        out.push(n)
        if (n.children?.length) walk(n.children)
      }
    }
    walk(tree)
    return out
  }

  return { getChildren, getDescendantsInclusive, getAncestors, getPath, buildTree, flattenTree }
}
