import { useNavigate } from 'react-router-dom'
import { X, Columns2 } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { useReportTabs, routeForTab } from './ReportTabsContext'

// 열린 보고서 탭 스트립.
//
// pane:
//  - 'left'  : 좌측(primary) 탭. 클릭=라우트 이동. 분할 버튼(Columns2)으로 그
//              보고서를 우측 패널에 추가. 닫기=closeTab.
//  - 'right' : 우측(secondary, 읽기전용 분할) 탭. 클릭=우측 활성 전환. 닫기=
//              closeRight. 분할 버튼 없음.
//
// placement:
//  - 'shell' : AppShell 콘텐츠 상단. 보고서 라우트가 아닐 때만 보인다(보고서
//              라우트에선 패널 안 탭바가 대신 보인다).
//  - 'pane'  : ReportSplitLayout 의 각 패널 상단. 보고서 라우트에서만.
//
// data-app-chrome: 전체화면(발표) 모드에서 index.css 가 자동 숨김.
export function ReportTabBar({ pane = 'left', placement = 'shell' }) {
  const ctx = useReportTabs()
  const navigate = useNavigate()

  if (pane === 'right') {
    return (
      <TabStrip
        tabs={ctx.rightTabs}
        activeKey={ctx.rightActiveKey}
        onSelect={(t) => ctx.setRightActive(t.key)}
        onClose={(t) => ctx.closeRight(t.key)}
      />
    )
  }

  // pane === 'left'
  // shell 배치는 비-보고서 라우트에서만(보고서 라우트에선 pane 배치가 담당).
  if (placement === 'shell' && ctx.onReportRoute) return null
  if (placement === 'pane' && !ctx.onReportRoute) return null

  return (
    <TabStrip
      tabs={ctx.tabs}
      activeKey={ctx.activeKey}
      onSelect={(t) => navigate(routeForTab(t))}
      onClose={(t) => ctx.closeTab(t.key)}
      // 분할: 활성 탭이 아닌 저장된 보고서만 우측에 띄울 수 있다.
      onSplit={(t) => ctx.openRight(t)}
      splitActiveKey={ctx.rightActiveKey}
      canSplit={(t) => t.key !== ctx.activeKey && Boolean(t.reportId)}
    />
  )
}

function TabStrip({
  tabs,
  activeKey,
  onSelect,
  onClose,
  onSplit = null,
  splitActiveKey = null,
  canSplit = null,
}) {
  if (!tabs || tabs.length === 0) return null
  return (
    <div
      data-app-chrome="report-tabs"
      className="flex items-stretch gap-1 overflow-x-auto border-b bg-muted/40 px-2 py-1 shrink-0 print:hidden"
    >
      {tabs.map((tab) => {
        const active = tab.key === activeKey
        const splittable = onSplit && canSplit?.(tab)
        const isSplit = onSplit && tab.key === splitActiveKey
        return (
          <div
            key={tab.key}
            role="button"
            tabIndex={0}
            title={tab.title}
            onClick={() => onSelect(tab)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(tab)
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
            {splittable && (
              <button
                type="button"
                aria-label="오른쪽에 분할로 보기"
                title="오른쪽에 분할로 보기"
                onClick={(e) => {
                  e.stopPropagation()
                  onSplit(tab)
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className={cn(
                  'inline-flex h-4 w-4 items-center justify-center rounded shrink-0 hover:bg-muted hover:text-foreground',
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
                onClose(tab)
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className={cn(
                'inline-flex h-4 w-4 items-center justify-center rounded shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground',
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
