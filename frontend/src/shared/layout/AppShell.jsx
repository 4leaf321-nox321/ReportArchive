import * as React from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Header } from './Header'
import { Sidebar, MobileSidebar } from './Sidebar'
import { MentionReturnBar } from './MentionReturnBar'
import { PresetEditBar } from './PresetEditBar'
import { ReportTabBar } from '@/shared/reports/ReportTabBar'
import { ReportSplitLayout } from '@/shared/reports/ReportSplitLayout'
import { useScrollRestoration } from './useScrollRestoration'
import { ErrorBoundary } from '@/shared/components/ErrorBoundary'
import { cn } from '@/shared/lib/utils'

/**
 * Top-level layout: header on top, sidebar on the left, page content fills the rest.
 *
 * - Desktop (md+): Sidebar always visible.
 * - Mobile: Sidebar lives inside MobileSidebar (Sheet) toggled from the header hamburger.
 *
 * Each route's content is wrapped in an ErrorBoundary so a crash on one
 * page doesn't take down the shell. The boundary resets when the URL changes.
 */
const SIDEBAR_COLLAPSED_KEY = 'ra:sidebar-collapsed:v1'

export function AppShell() {
  const [mobileOpen, setMobileOpen] = React.useState(false)
  // 데스크톱 사이드바 접기 상태 — 새로고침해도 유지되게 localStorage 에 저장.
  const [collapsed, setCollapsed] = React.useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  React.useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      /* localStorage 차단 환경(프라이빗 모드 등) — 저장 생략 */
    }
  }, [collapsed])
  const location = useLocation()
  const mainRef = React.useRef(null)
  // 뒤로가기 시 <main> 스크롤 위치 복원(@멘션 복귀 포함, 앱 전체에 적용).
  useScrollRestoration(mainRef)

  return (
    <div className="flex h-full flex-col">
      <Header onOpenMobileSidebar={() => setMobileOpen(true)} />
      <div className="relative flex flex-1 min-h-0">
        <Sidebar collapsed={collapsed} />
        <MobileSidebar open={mobileOpen} onOpenChange={setMobileOpen} />

        {/* 데스크톱 — 사이드바 가장자리 손잡이(접기/펼치기). aside 바깥(클립
            영역 밖)에 절대배치라 접혀도(w-0) 항상 보이고, 사이드바 폭에 맞춰
            같은 속도로 따라 움직인다(left 0 ↔ 15rem). 모바일은 햄버거 사용. */}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
          aria-pressed={collapsed}
          title={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
          className={cn(
            'hidden md:flex absolute top-1/2 -translate-y-1/2 z-30 h-10 w-5 items-center justify-center',
            'rounded-r-md border border-l-0 bg-card text-muted-foreground shadow-sm',
            'hover:bg-muted hover:text-foreground',
            'transition-[left,background-color,color] duration-200 ease-in-out',
            collapsed ? 'left-0' : 'left-60'
          )}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>
        {/* 콘텐츠 컬럼 — 사이드바 오른쪽. 보고서 탭 스트립을 여기 두어 탭
            구간이 좌측 사이드바를 덮지 않고 콘텐츠 영역 안에서만 깔리게 한다. */}
        <div className="flex flex-1 min-w-0 flex-col">
          {/* 비-보고서 화면용 좌측 탭 스트립(목록·대시보드 등에서 열린 보고서로
              빠르게 복귀). 보고서 라우트에선 null 을 반환하고, 대신 좌측 탭바는
              ReportDetailPage 의 편집 컬럼 안(폴더 사이드바 오른쪽), 우측 탭바는
              ReportSplitLayout 의 우측 패널 상단에서 보인다. */}
          <ReportTabBar pane="left" placement="shell" />
          <main ref={mainRef} className="flex-1 min-w-0 overflow-y-auto bg-muted/30">
            <MentionReturnBar />
            <PresetEditBar />
            {/* ReportSplitLayout 은 분할이 꺼져 있으면 display:contents 로 투명해
                져 기존 레이아웃과 동일하게 동작하고, 켜지면 좌(에디터)·우(읽기전용)
                2열로 나눈다. 토글 시 에디터가 remount 되지 않도록 래퍼 DOM 을 항상
                유지한다(ReportSplitLayout 주석 참조). */}
            <ReportSplitLayout>
              <ErrorBoundary resetKey={location.pathname}>
                <Outlet />
              </ErrorBoundary>
            </ReportSplitLayout>
          </main>
        </div>
      </div>
    </div>
  )
}
