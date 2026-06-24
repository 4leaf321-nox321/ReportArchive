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

  // 워크스페이스 레지스트리 재요청 — TF 개설/보관 후 목록을 즉시 갱신하는 데 쓴다
  // (mount 시 1회 + 명시 호출). 반환 Promise 로 호출부가 완료를 기다릴 수 있다.
  const reload = React.useCallback(() => {
    setLoading(true)
    return listWorkspaces()
      .then((data) => {
        setAll(data || [])
        setError(null)
      })
      .catch((err) => setError(err))
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    reload()
  }, [reload])

  const slugMap = React.useMemo(() => {
    const m = new Map()
    for (const w of all) m.set(w.slug, w)
    return m
  }, [all])

  const match = matchPath({ path: '/w/:workspace/*' }, location.pathname)
  const requestedSlug = match?.params?.workspace
  // Personal page (/personal/*): use the user's personal workspace as
  // the effective slug for API calls, but DO NOT touch the sticky org
  // context. The sidebar's 부서 메뉴 keeps pointing at the last org.
  const personalRoute = matchPath(
    { path: '/personal/*' },
    location.pathname,
  )
  const isPersonalPage = Boolean(personalRoute)

  const isOrg = (s) => s && !s.startsWith('personal-')
  const myPersonalSlug = me?.user?.id ? `personal-${me.user.id}` : null
  const userFirstOrgSlug = me?.memberships?.find(
    (m) => !m.workspace_slug.startsWith('personal-')
  )?.workspace_slug

  // ── effectiveSlug = workspace used by API calls on the current page
  //    For org URLs: that org. For personal URLs (or /personal/*):
  //    user's personal workspace. For neutral pages (/templates etc.):
  //    falls through to the sticky org context.
  // ── orgSlug = workspace shown in the sidebar selector + used to
  //    build 부서 메뉴 URLs. NEVER personal; sticks until the user
  //    explicitly switches via the selector.
  const recentOrgSlug = (prefs.recent || []).find(
    (s) => isOrg(s) && slugMap.has(s),
  )
  const orgFallback =
    recentOrgSlug ||
    (userFirstOrgSlug && slugMap.has(userFirstOrgSlug) && userFirstOrgSlug) ||
    (slugMap.has(DEFAULT_FALLBACK) && DEFAULT_FALLBACK) ||
    // ⚠ kind==='org' 명시 — TF(parent_slug=null)·가상이 fallback 으로
    // 잘못 잡히지 않게(TF 는 트리 밖이라 부서 fallback 대상 아님).
    all.find((w) => w.kind === 'org' && w.parent_slug === null)?.slug

  let effectiveSlug
  if (isPersonalPage && myPersonalSlug && slugMap.has(myPersonalSlug)) {
    effectiveSlug = myPersonalSlug
  } else if (requestedSlug && slugMap.has(requestedSlug)) {
    effectiveSlug = requestedSlug
  } else {
    effectiveSlug = orgFallback
  }

  // orgSlug — never personal. If the URL is on an org, use that org;
  // otherwise stick to the most recent org (or fallback).
  const orgSlug =
    (isOrg(effectiveSlug) && effectiveSlug) ||
    orgFallback ||
    null

  const slug = effectiveSlug
  const workspace = slug ? slugMap.get(slug) : null
  const orgWorkspace = orgSlug ? slugMap.get(orgSlug) : null

  // Sync header for outgoing requests + track recent visits + re-resolve
  // the user's role on the new workspace. /api/me returns role=null when no
  // X-Workspace-Slug header is present, so we re-fetch once the slug is set.
  // Only push ORG slugs to `recent` — personal context is a separate
  // sticky concept (always returns to the user's own personal space)
  // and doesn't need recency tracking.
  React.useEffect(() => {
    if (workspace) {
      setCurrentWorkspace(workspace.slug)
      if (isOrg(workspace.slug)) {
        prefs.pushRecent(workspace.slug)
      }
      refreshAuth()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.slug])

  // 부서 전환 — 부서 홈으로 가지 않고, 현재 보던 *섹션*(보고서/관계도/종합보고/
  // 대시보드 등)을 유지한 채 부서만 바꾼다. 상세(ID) 경로는 그 부서 전용이라
  // 섹션 루트로 떨어뜨린다. 쿼리(관계도 등 URL 기반 설정)는 유지해 설정도
  // 보존한다 — 단 보고서는 부서마다 폴더구조가 달라 메인(쿼리 미유지)으로.
  const switchWorkspace = React.useCallback(
    (nextSlug) => {
      const m = matchPath({ path: '/w/:workspace/*' }, location.pathname)
      const rest = m?.params?.['*'] ?? ''
      const section = rest.split('/')[0] ?? ''
      const dest = section ? `/w/${nextSlug}/${section}` : `/w/${nextSlug}`
      const search = section && section !== 'reports' ? location.search : ''
      navigate(`${dest}${search}`)
    },
    [navigate, location.pathname, location.search]
  )

  // Tree helpers — kept here so the provider is the single source of truth.
  const helpers = React.useMemo(() => makeHelpers(all), [all])

  // 로컬 패치 — 워크스페이스 한 건의 필드를 갱신(전체 재요청 없이). 게시판
  // 공개 토글(external_view_default) 후 컨텍스트를 즉시 반영하는 데 쓴다.
  const patchWorkspace = React.useCallback((slug, partial) => {
    setAll((prev) =>
      prev.map((w) => (w.slug === slug ? { ...w, ...partial } : w)),
    )
  }, [])

  const value = React.useMemo(
    () => ({
      // `workspace` / `slug` = effective workspace for the CURRENT page
      // (can be personal). API calls and page-scoped data use this.
      workspace,
      slug: workspace?.slug,
      // `orgWorkspace` / `orgSlug` = sticky org context, never personal.
      // 부서 메뉴 links and the workspace selector use this so that
      // visiting personal-only routes doesn't yank the sidebar off the
      // user's current org.
      orgWorkspace,
      orgSlug,
      isPersonalPage,
      all,
      loading,
      error,
      switchWorkspace,
      patchWorkspace,
      reload,
      prefs,
      ...helpers,
    }),
    [
      workspace,
      orgWorkspace,
      orgSlug,
      isPersonalPage,
      all,
      loading,
      error,
      switchWorkspace,
      patchWorkspace,
      reload,
      prefs,
      helpers,
    ]
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

  function buildTree({
    includeVirtual = false,
    includePersonal = false,
    includeTf = false,
  } = {}) {
    // TF(kind=tf)는 트리 밖(parent_slug=null)이라 그대로 두면 조직도 루트로
    // 잘못 그려진다 — 기본 제외. "내 TF" 섹션이 별도로 평면 렌더한다.
    const keep = (w) =>
      (includeVirtual || !w.virtual) &&
      (includePersonal || w.kind !== 'personal') &&
      (includeTf || w.kind !== 'tf')
    function attach(node, depth) {
      return {
        ...node,
        depth,
        children: getChildren(node.slug)
          .filter(keep)
          .map((c) => attach(c, depth + 1)),
      }
    }
    return all
      .filter((w) => w.parent_slug === null && keep(w))
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
