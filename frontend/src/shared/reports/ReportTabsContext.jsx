import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useLocation, useNavigate, matchPath } from 'react-router-dom'
import { useAuth } from '@/shared/auth/AuthContext'
import { toast } from 'sonner'

// 여러 보고서를 "탭"으로 열어두고 전환 + 좌/우 분할 보기 상태 저장소.
//
// 두 개의 탭 세트(좌=URL 편집 보고서, 우=읽기전용 분할). **한 보고서는 한
// 패널에만** 존재한다(좌 또는 우, 동시 불가). URL/활성 보고서는 항상 좌측이다.
//  - 좌측의 탭을 "우측에 분할로 보기" 하거나 우측 탭바로 드래그하면 좌측에서
//    사라지고 우측으로 옮겨간다.
//  - 우측 탭을 좌측 탭바로 드래그하면 그 보고서로 이동(편집 화면)하고 우측에서
//    사라진다. activeKey 는 저장하지 않고 URL 에서 파생한다.
//
// 무거운 ReportDetailPage(에디터)는 좌측(라우트) 1개만 마운트하고, 우측은
// 읽기전용 InlineReportView 라 싱글톤(편집락·useBlocker·전역리스너) 충돌이 없다.
//
// 영속은 sessionStorage(창별 작업셋).

const MAX_TABS = 12
const STORAGE_PREFIX = 'ra:report-tabs:v2:'

const ReportTabsContext = createContext(null)

/** 현재 경로에서 활성 보고서(좌측) 탭 key 를 파생. 보고서 상세 라우트가 아니면 null. */
function deriveActiveKey(pathname) {
  const newMatch = matchPath(
    { path: '/w/:workspace/reports/new/:templateId/:version' },
    pathname,
  )
  if (newMatch) {
    const { templateId, version } = newMatch.params
    return `new:${templateId}:${version}`
  }
  const rptMatch = matchPath({ path: '/w/:workspace/reports/:reportId' }, pathname)
  if (rptMatch && rptMatch.params.reportId !== 'new') {
    return `r:${rptMatch.params.reportId}`
  }
  return null
}

/** 탭 → 라우트 경로. */
export function routeForTab(tab) {
  if (!tab) return null
  if (tab.reportId) return `/w/${tab.slug}/reports/${tab.reportId}`
  if (tab.templateId)
    return `/w/${tab.slug}/reports/new/${tab.templateId}/${tab.version}`
  return null
}

function loadStored(userId) {
  const empty = { tabs: [], rightTabs: [], rightActiveKey: null }
  if (!userId) return empty
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + userId)
    if (!raw) return empty
    const p = JSON.parse(raw)
    return {
      tabs: Array.isArray(p?.tabs) ? p.tabs : [],
      rightTabs: Array.isArray(p?.rightTabs) ? p.rightTabs : [],
      rightActiveKey: typeof p?.rightActiveKey === 'string' ? p.rightActiveKey : null,
    }
  } catch {
    return empty
  }
}

/** 우측 탭 엔트리 정규화(저장된 보고서만). */
function toRightEntry(tab) {
  return {
    key: tab.key,
    slug: tab.slug,
    reportId: String(tab.reportId),
    templateId: null,
    version: null,
    title: tab.title || '제목 없음',
  }
}

export function ReportTabsProvider({ children }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { me } = useAuth()
  const userId = me?.user?.id ?? null

  const [tabs, setTabs] = useState([])
  const [rightTabs, setRightTabs] = useState([])
  const [rightActiveKey, setRightActiveKey] = useState(null)
  const pendingCloseRef = useRef(null)

  const activeKey = useMemo(
    () => deriveActiveKey(location.pathname),
    [location.pathname],
  )
  const onReportRoute = Boolean(activeKey)

  // 콜백에서 deps 없이 최신값을 읽기 위한 ref — 콜백 identity 를 안정적으로 유지.
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const rightTabsRef = useRef(rightTabs)
  rightTabsRef.current = rightTabs
  const activeKeyRef = useRef(activeKey)
  activeKeyRef.current = activeKey
  const rightActiveKeyRef = useRef(rightActiveKey)
  rightActiveKeyRef.current = rightActiveKey

  useEffect(() => {
    const s = loadStored(userId)
    setTabs(s.tabs)
    setRightTabs(s.rightTabs)
    setRightActiveKey(s.rightActiveKey)
  }, [userId])

  useEffect(() => {
    if (!userId) return
    try {
      sessionStorage.setItem(
        STORAGE_PREFIX + userId,
        JSON.stringify({ tabs, rightTabs, rightActiveKey }),
      )
    } catch {
      /* 프라이빗 모드 등 */
    }
  }, [userId, tabs, rightTabs, rightActiveKey])

  useEffect(() => {
    const pending = pendingCloseRef.current
    if (pending && activeKey !== pending) {
      pendingCloseRef.current = null
      setTabs((prev) => prev.filter((t) => t.key !== pending))
    }
  }, [activeKey])

  // 우측에서 제거 + 활성 보정(refs 사용, 안정 콜백).
  const removeFromRight = useCallback((key) => {
    const cur = rightTabsRef.current
    const idx = cur.findIndex((t) => t.key === key)
    if (idx < 0) return
    setRightTabs(cur.filter((t) => t.key !== key))
    if (rightActiveKeyRef.current === key) {
      const neighbor = cur[idx + 1] ?? cur[idx - 1] ?? null
      setRightActiveKey(neighbor ? neighbor.key : null)
    }
  }, [])

  // ── 좌측(primary) 탭 ─────────────────────────────────────────────────
  const upsertTab = useCallback(
    (tab) => {
      if (!tab?.key) return
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.key === tab.key)
        if (idx >= 0) {
          const next = prev.slice()
          next[idx] = { ...next[idx], ...tab, title: tab.title || next[idx].title }
          return next
        }
        let base = prev
        if (prev.length >= MAX_TABS) {
          const evictIdx = prev.findIndex((t) => t.key !== tab.key)
          if (evictIdx >= 0) {
            base = prev.slice(0, evictIdx).concat(prev.slice(evictIdx + 1))
            toast.info('열린 보고서 탭이 많아 가장 오래된 탭을 닫았습니다.')
          }
        }
        return [...base, tab]
      })
      // 한 보고서는 한 패널만 — URL/활성 보고서는 항상 좌측이므로 우측 중복 제거.
      removeFromRight(tab.key)
    },
    [removeFromRight],
  )

  const promoteNewTab = useCallback((oldKey, { reportId, slug, title }) => {
    const newKey = `r:${reportId}`
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.key === oldKey)
      const promoted = {
        key: newKey,
        slug,
        reportId: String(reportId),
        templateId: null,
        version: null,
        title: title || '제목 없음',
      }
      if (idx < 0) {
        if (prev.some((t) => t.key === newKey)) return prev
        return [...prev, promoted]
      }
      const next = prev.slice()
      next[idx] = promoted
      return next.filter((t, i) => i === idx || t.key !== newKey)
    })
  }, [])

  const closeTab = useCallback(
    (key) => {
      if (key !== activeKey) {
        setTabs((prev) => prev.filter((t) => t.key !== key))
        return
      }
      const idx = tabs.findIndex((t) => t.key === key)
      const neighbor = tabs[idx + 1] ?? tabs[idx - 1] ?? null
      pendingCloseRef.current = key
      if (neighbor) {
        navigate(routeForTab(neighbor))
      } else {
        const slug = tabs[idx]?.slug
        navigate(slug ? `/w/${slug}/reports` : '/')
      }
    },
    [activeKey, tabs, navigate],
  )

  const dropTab = useCallback((key) => {
    setTabs((prev) => prev.filter((t) => t.key !== key))
  }, [])

  // ── 우측(secondary, 읽기전용 분할) 탭 ────────────────────────────────
  const setRightActive = useCallback((key) => {
    setRightActiveKey(key)
  }, [])

  const closeRight = useCallback(
    (key) => {
      removeFromRight(key)
    },
    [removeFromRight],
  )

  // ── 좌 ↔ 우 이동(분할 버튼 + 드래그드롭) ─────────────────────────────
  // 우측으로: 좌측에서 제거 + 우측에 추가/활성화. 저장된 보고서만, 활성(편집중)
  // 탭은 제외(좌측이 비어버리지 않게).
  const moveToRight = useCallback((key) => {
    const tab = tabsRef.current.find((t) => t.key === key)
    if (!tab || !tab.reportId) return
    if (key === activeKeyRef.current) return
    setTabs((prev) => prev.filter((t) => t.key !== key))
    setRightTabs((prev) =>
      prev.some((t) => t.key === key) ? prev : [...prev, toRightEntry(tab)],
    )
    setRightActiveKey(key)
  }, [])

  // 좌측으로: 그 보고서로 URL 이동(편집 화면). 이동 성공 시 upsertTab 이 좌측에
  // 넣고 우측에서 제거(dedup) — 미저장 가드로 취소되면 우측 그대로라 유실 없음.
  const moveToLeft = useCallback(
    (key) => {
      const tab = rightTabsRef.current.find((t) => t.key === key)
      if (!tab) return
      const route = routeForTab(tab)
      if (route) navigate(route)
    },
    [navigate],
  )

  // 드래그드롭/분할버튼 공용 진입점. targetPane 쪽으로 옮긴다. 대상이 그 패널의
  // "반대편"에 있을 때만 실제로 동작(같은 패널 내 드롭은 무해한 no-op).
  const moveTab = useCallback(
    (key, targetPane) => {
      if (targetPane === 'right') moveToRight(key)
      else moveToLeft(key)
    },
    [moveToRight, moveToLeft],
  )

  const rightTab = useMemo(
    () => (rightActiveKey ? rightTabs.find((t) => t.key === rightActiveKey) ?? null : null),
    [rightActiveKey, rightTabs],
  )
  const splitOpen = onReportRoute && Boolean(rightTab)

  const value = useMemo(
    () => ({
      // 좌측
      tabs,
      activeKey,
      onReportRoute,
      upsertTab,
      promoteNewTab,
      closeTab,
      dropTab,
      // 우측(분할)
      rightTabs,
      rightActiveKey,
      rightTab,
      splitOpen,
      setRightActive,
      closeRight,
      // 이동(분할버튼 + 드래그드롭)
      moveTab,
    }),
    [
      tabs,
      activeKey,
      onReportRoute,
      upsertTab,
      promoteNewTab,
      closeTab,
      dropTab,
      rightTabs,
      rightActiveKey,
      rightTab,
      splitOpen,
      setRightActive,
      closeRight,
      moveTab,
    ],
  )

  return (
    <ReportTabsContext.Provider value={value}>{children}</ReportTabsContext.Provider>
  )
}

export function useReportTabs() {
  const ctx = useContext(ReportTabsContext)
  if (!ctx) throw new Error('useReportTabs must be used within ReportTabsProvider')
  return ctx
}
