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
  // 활성(편집중) 좌측 탭을 우측으로 보낼 때, 이웃으로의 라우트 이동이 성공한
  // 뒤에만 실제 이동을 커밋하기 위한 보류 키. 미저장 가드에서 "머무름"을 고르면
  // ReportDetailPage 가 clearPendingMove() 로 취소한다(유실/오작동 방지).
  const pendingMoveRightRef = useRef(null)

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

  // 활성 탭 우측 이동 보류 처리 — 라우트가 실제로 바뀌면(미저장 가드 통과) 그
  // 보고서를 좌측에서 빼서 우측에 추가·활성화한다. 가드에서 머무르면 activeKey
  // 가 그대로라 이 effect 가 동작하지 않고, clearPendingMove 로 보류가 풀린다.
  useEffect(() => {
    const pending = pendingMoveRightRef.current
    if (pending && activeKey !== pending) {
      pendingMoveRightRef.current = null
      const tab = tabsRef.current.find((t) => t.key === pending)
      setTabs((prev) => prev.filter((t) => t.key !== pending))
      if (tab && tab.reportId) {
        setRightTabs((prev) =>
          prev.some((t) => t.key === pending) ? prev : [...prev, toRightEntry(tab)],
        )
        setRightActiveKey(pending)
      }
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
  // 우측으로: 좌측에서 제거 + 우측 toIndex 위치에 추가/활성화(저장된 보고서만).
  // 활성(편집중) 탭이면 좌측을 이웃으로 비운 뒤 옮긴다(라우트 이동 성공 시 커밋).
  const moveToRight = useCallback(
    (key, toIndex) => {
      const tab = tabsRef.current.find((t) => t.key === key)
      if (!tab || !tab.reportId) return
      if (key === activeKeyRef.current) {
        const cur = tabsRef.current
        const idx = cur.findIndex((t) => t.key === key)
        const neighbor = cur[idx + 1] ?? cur[idx - 1] ?? null
        if (!neighbor) {
          toast.info('편집 창에 열어둘 다른 보고서가 없어 이동할 수 없습니다.')
          return
        }
        // 이웃으로 이동(미저장이면 가드가 저장 여부를 묻는다). 실제 이동은 위
        // effect 가 라우트 변경 성공 후 커밋.
        pendingMoveRightRef.current = key
        navigate(routeForTab(neighbor))
        return
      }
      setTabs((prev) => prev.filter((t) => t.key !== key))
      setRightTabs((prev) => {
        if (prev.some((t) => t.key === key)) return prev
        const next = prev.slice()
        const at =
          typeof toIndex === 'number'
            ? Math.max(0, Math.min(toIndex, next.length))
            : next.length
        next.splice(at, 0, toRightEntry(tab))
        return next
      })
      setRightActiveKey(key)
    },
    [navigate],
  )

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
  // "반대편"에 있을 때만 실제로 동작(같은 패널 내 드롭은 reorderTab 이 담당).
  const moveTab = useCallback(
    (key, targetPane, toIndex) => {
      if (targetPane === 'right') moveToRight(key, toIndex)
      else moveToLeft(key)
    },
    [moveToRight, moveToLeft],
  )

  // 같은 패널 내 순서 변경 — key 를 toIndex(삽입 위치)로 이동.
  const reorderTab = useCallback((pane, key, toIndex) => {
    const setter = pane === 'right' ? setRightTabs : setTabs
    setter((prev) => {
      const fromIdx = prev.findIndex((t) => t.key === key)
      if (fromIdx < 0) return prev
      const next = prev.slice()
      const [item] = next.splice(fromIdx, 1)
      let at = typeof toIndex === 'number' ? toIndex : next.length
      if (fromIdx < at) at -= 1
      at = Math.max(0, Math.min(at, next.length))
      next.splice(at, 0, item)
      return next
    })
  }, [])

  // 활성 탭 우측 이동 보류 취소 — 미저장 가드에서 "머무름"을 골랐을 때 호출.
  const clearPendingMove = useCallback(() => {
    pendingMoveRightRef.current = null
  }, [])

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
      // 이동(분할버튼 + 드래그드롭) + 순서 변경
      moveTab,
      reorderTab,
      clearPendingMove,
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
      reorderTab,
      clearPendingMove,
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
