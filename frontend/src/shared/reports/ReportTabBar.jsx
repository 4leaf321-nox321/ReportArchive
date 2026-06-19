import { useNavigate } from 'react-router-dom'
import { X, Columns2 } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { useReportTabs, routeForTab } from './ReportTabsContext'

// 열린 보고서 탭 스트립. Header 아래·본문 행 위에 전체폭으로 깔린다.
// 열린 탭이 없으면 아무것도 렌더하지 않아(레이아웃 변화 없음) 비-보고서
// 페이지에선 보이지 않는다.
//
// data-app-chrome: 발표/전체화면 모드에서 index.css 의
// `body.report-fullscreen [data-app-chrome]` 셀렉터가 자동으로 숨긴다.
export function ReportTabBar() {
  const { tabs, activeKey, splitKey, closeTab, setSplit } = useReportTabs()
  const navigate = useNavigate()

  if (tabs.length === 0) return null

  return (
    <div
      data-app-chrome="report-tabs"
      className="flex items-stretch gap-1 overflow-x-auto border-b bg-muted/40 px-2 py-1 print:hidden"
    >
      {tabs.map((tab) => {
        const active = tab.key === activeKey
        // 분할 우측에 띄울 수 있는 탭 = 활성 탭이 아니고 저장된(r:) 보고서.
        const canSplit = !active && Boolean(tab.reportId)
        const isSplit = tab.key === splitKey
        return (
          <div
            key={tab.key}
            role="button"
            tabIndex={0}
            title={tab.title}
            onClick={() => navigate(routeForTab(tab))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                navigate(routeForTab(tab))
              }
            }}
            className={cn(
              'group flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs cursor-pointer select-none shrink-0 max-w-[200px]',
              active
                ? 'border-border bg-background text-foreground shadow-sm'
                : 'border-transparent bg-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground',
            )}
          >
            <span className="truncate">{tab.title || '불러오는 중…'}</span>
            {canSplit && (
              <button
                type="button"
                aria-label={isSplit ? '분할 닫기' : '오른쪽에 분할로 보기'}
                title={isSplit ? '분할 닫기' : '오른쪽에 분할로 보기'}
                onClick={(e) => {
                  e.stopPropagation()
                  setSplit(isSplit ? null : tab.key)
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className={cn(
                  'inline-flex h-4 w-4 items-center justify-center rounded shrink-0',
                  'hover:bg-muted hover:text-foreground',
                  isSplit
                    ? 'text-primary opacity-100'
                    : 'text-muted-foreground opacity-0 group-hover:opacity-70',
                )}
              >
                <Columns2 className="h-3 w-3" />
              </button>
            )}
            <button
              type="button"
              aria-label="탭 닫기"
              title="탭 닫기"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.key)
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className={cn(
                'inline-flex h-4 w-4 items-center justify-center rounded shrink-0',
                'text-muted-foreground hover:bg-muted hover:text-foreground',
                active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70',
              )}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
