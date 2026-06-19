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
// 두 개의 독립된 탭 세트:
//  - 좌측(primary): URL 에 걸린 편집 가능한 보고서. activeKey 는 저장하지 않고
//    현재 URL 에서 파생(matchPath) — back/forward·딥링크에도 항상 정합.
//  - 우측(secondary): 분할 보기의 읽기전용 패널이 보여주는 보고서들. URL 과
//    무관하게 rightActiveKey 로 추적·sessionStorage 에 저장.
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

export function ReportTabsProvider({ children }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { me } = useAuth()
  const userId = me?.user?.id ?? null

  const [tabs, setTabs] = useState([])
  const [rightTabs, setRightTabs] = useState([])
  const [rightActiveKey, setRightActiveKey] = useState(null)
  // 활성 탭 닫기 → navigate 후 라우트가 실제로 바뀌었을 때만 제거(미저장 가드
  // 가 이동을 막고 사용자가 머무르면 탭 유지).
  const pendingCloseRef = useRef(null)

  const activeKey = useMemo(
    () => deriveActiveKey(location.pathname),
    [location.pathname],
  )
  // 보고서 상세 라우트 위에 있는지 — 분할/패널 탭바 표시 여부 판정용.
  const onReportRoute = Boolean(activeKey)

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

  // 활성 탭 닫기 보류 처리.
  useEffect(() => {
    const pending = pendingCloseRef.current
    if (pending && activeKey !== pending) {
      pendingCloseRef.current = null
      setTabs((prev) => prev.filter((t) => t.key !== pending))
    }
  }, [activeKey])

  // ── 좌측(primary) 탭 ─────────────────────────────────────────────────
  const upsertTab = useCallback((tab) => {
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
  }, [])

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
  /** 좌측 탭의 "분할" 버튼 → 그 보고서를 우측 패널에 추가하고 활성화. */
  const openRight = useCallback((tab) => {
    if (!tab?.reportId) return // 저장된 보고서만(읽기전용 fetch 에 id 필요)
    const entry = {
      key: tab.key,
      slug: tab.slug,
      reportId: String(tab.reportId),
      templateId: null,
      version: null,
      title: tab.title || '제목 없음',
    }
    setRightTabs((prev) => {
      const idx = prev.findIndex((t) => t.key === entry.key)
      if (idx >= 0) {
        const next = prev.slice()
        next[idx] = { ...next[idx], ...entry, title: entry.title || next[idx].title }
        return next
      }
      return [...prev, entry]
    })
    setRightActiveKey(entry.key)
  }, [])

  const setRightActive = useCallback((key) => {
    setRightActiveKey(key)
  }, [])

  const closeRight = useCallback((key) => {
    setRightTabs((prev) => {
      const idx = prev.findIndex((t) => t.key === key)
      const next = prev.filter((t) => t.key !== key)
      setRightActiveKey((cur) => {
        if (cur !== key) return cur
        const neighbor = next[idx] ?? next[idx - 1] ?? null
        return neighbor ? neighbor.key : null
      })
      return next
    })
  }, [])

  const rightTab = useMemo(
    () =>
      rightActiveKey ? rightTabs.find((t) => t.key === rightActiveKey) ?? null : null,
    [rightActiveKey, rightTabs],
  )
  // 분할이 실제로 보이는 조건: 보고서 라우트 + 우측에 보여줄 탭 존재.
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
      openRight,
      setRightActive,
      closeRight,
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
      openRight,
      setRightActive,
      closeRight,
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
