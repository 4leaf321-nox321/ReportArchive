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

// 여러 보고서를 "탭"으로 열어두고 전환하는 기능의 상태 저장소.
//
// 설계 핵심: 무거운 ReportDetailPage(에디터)는 라우트에 걸린 1개만 마운트하고,
// 이 Context 는 "열린 보고서 목록"만 들고 있는다. activeKey 는 저장하지 않고
// 현재 URL 에서 파생(matchPath) — 브라우저 back/forward·딥링크에도 항상 정합.
// 분할 보기(splitKey)는 라우트 파생이 아니라 상태로 저장한다(Phase 2).
//
// 영속은 sessionStorage(창별 작업셋) — 두 창이 독립된 탭 스트립을 갖는다.

const MAX_TABS = 12
const STORAGE_PREFIX = 'ra:report-tabs:v1:'

const ReportTabsContext = createContext(null)

/** 현재 경로에서 활성 보고서 탭 key 를 파생. 보고서 상세 라우트가 아니면 null. */
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
  // `/reports/new`(템플릿 선택 페이지)는 reportId='new' 로 잡히지만 실제
  // 보고서가 아니므로 탭으로 만들지 않는다.
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
  if (!userId) return { tabs: [], splitKey: null }
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + userId)
    if (!raw) return { tabs: [], splitKey: null }
    const parsed = JSON.parse(raw)
    return {
      tabs: Array.isArray(parsed?.tabs) ? parsed.tabs : [],
      splitKey: typeof parsed?.splitKey === 'string' ? parsed.splitKey : null,
    }
  } catch {
    return { tabs: [], splitKey: null }
  }
}

export function ReportTabsProvider({ children }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { me } = useAuth()
  const userId = me?.user?.id ?? null

  const [tabs, setTabs] = useState([])
  const [splitKey, setSplitKey] = useState(null)
  // 활성 탭 닫기 → navigate 후, 라우트가 실제로 바뀌었을 때만 배열에서 제거하기
  // 위한 보류 키(미저장 가드가 이동을 막고 사용자가 머무르면 탭이 안 사라짐).
  const pendingCloseRef = useRef(null)

  const activeKey = useMemo(
    () => deriveActiveKey(location.pathname),
    [location.pathname],
  )

  // 사용자별 sessionStorage 에서 복원(계정 전환 대비 userId 키).
  useEffect(() => {
    const stored = loadStored(userId)
    setTabs(stored.tabs)
    setSplitKey(stored.splitKey)
  }, [userId])

  // 변경 시 영속.
  useEffect(() => {
    if (!userId) return
    try {
      sessionStorage.setItem(
        STORAGE_PREFIX + userId,
        JSON.stringify({ tabs, splitKey }),
      )
    } catch {
      /* 프라이빗 모드 등 — 저장 생략 */
    }
  }, [userId, tabs, splitKey])

  // 활성 탭 닫기 보류 처리: 라우트가 보류 키에서 벗어나면(이동 성공) 제거.
  useEffect(() => {
    const pending = pendingCloseRef.current
    if (pending && activeKey !== pending) {
      pendingCloseRef.current = null
      setTabs((prev) => prev.filter((t) => t.key !== pending))
      setSplitKey((s) => (s === pending ? null : s))
    }
  }, [activeKey])

  /** 보고서 진입 시 호출(ReportDetailPage 의 sync effect). 있으면 메타 갱신,
   *  없으면 추가. 상한 초과 시 활성 아닌 가장 오래된 탭을 밀어낸다. */
  const upsertTab = useCallback(
    (tab) => {
      if (!tab?.key) return
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.key === tab.key)
        if (idx >= 0) {
          const next = prev.slice()
          // title 등 메타만 갱신(빈 title 로 덮어쓰지 않음).
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
    },
    [],
  )

  /** 새 보고서(new:) 탭을 저장된 보고서(r:) 탭으로 같은 자리에서 교체. 저장
   *  성공 시 ReportDetailPage 가 호출(라우트가 replace 로 바뀌기 직전/직후). */
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
        // 원래 탭이 없으면(엣지) 그냥 추가.
        if (prev.some((t) => t.key === newKey)) return prev
        return [...prev, promoted]
      }
      const next = prev.slice()
      next[idx] = promoted
      // 혹시 같은 reportId 탭이 이미 있으면 중복 제거.
      return next.filter((t, i) => i === idx || t.key !== newKey)
    })
  }, [])

  const closeTab = useCallback(
    (key) => {
      setSplitKey((s) => (s === key ? null : s))
      if (key !== activeKey) {
        // 비활성 탭: 마운트돼 있지 않으므로 즉시 제거(락·가드 없음).
        setTabs((prev) => prev.filter((t) => t.key !== key))
        return
      }
      // 활성 탭: 이웃으로 이동(오른쪽 우선), 마지막이면 목록으로. 실제 이동
      // 성공 시에만 제거(위 effect) — 미저장 가드가 막으면 탭 유지.
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

  /** 내비게이션 없이 탭만 제거 — 새 보고서 작성을 취소(이미 다른 곳으로
   *  이동)할 때처럼, 호출측이 라우팅을 직접 처리하는 경우에 쓴다. */
  const dropTab = useCallback((key) => {
    setTabs((prev) => prev.filter((t) => t.key !== key))
    setSplitKey((s) => (s === key ? null : s))
  }, [])

  const setSplit = useCallback(
    (key) => {
      // 활성 탭이나 미저장 새 보고서는 분할 우측(읽기전용)으로 못 띄운다.
      if (!key || key === activeKey) {
        setSplitKey(null)
        return
      }
      const t = tabs.find((x) => x.key === key)
      if (!t?.reportId) return
      setSplitKey(key)
    },
    [activeKey, tabs],
  )

  const splitTab = useMemo(
    () => (splitKey ? tabs.find((t) => t.key === splitKey) ?? null : null),
    [splitKey, tabs],
  )

  const value = useMemo(
    () => ({
      tabs,
      activeKey,
      splitKey: splitTab ? splitKey : null,
      splitTab,
      upsertTab,
      promoteNewTab,
      closeTab,
      dropTab,
      setSplit,
    }),
    [tabs, activeKey, splitKey, splitTab, upsertTab, promoteNewTab, closeTab, dropTab, setSplit],
  )

  return (
    <ReportTabsContext.Provider value={value}>
      {children}
    </ReportTabsContext.Provider>
  )
}

export function useReportTabs() {
  const ctx = useContext(ReportTabsContext)
  if (!ctx) {
    throw new Error('useReportTabs must be used within ReportTabsProvider')
  }
  return ctx
}
