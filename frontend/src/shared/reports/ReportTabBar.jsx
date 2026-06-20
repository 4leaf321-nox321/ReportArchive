import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, Columns2 } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { useReportTabs, routeForTab } from './ReportTabsContext'

const DND_MIME = 'application/x-report-tab'

// 열린 보고서 탭 스트립.
//
// pane:
//  - 'left'  : 좌측(primary) 탭. 클릭=라우트 이동. 분할 버튼(Columns2)으로 그
//              보고서를 우측 패널로 옮긴다(좌측에서 사라짐). 닫기=closeTab.
//  - 'right' : 우측(secondary, 읽기전용 분할) 탭. 클릭=우측 활성 전환. 닫기=
//              closeRight. 분할 버튼 없음.
//
// 드래그드롭: 탭을 반대편 패널의 탭바로 끌어다 놓으면 그 패널로 이동한다.
// 한 보고서는 한 패널에만 존재(중복 없음).
//
// placement:
//  - 'shell' : AppShell 콘텐츠 상단. 보고서 라우트가 아닐 때만 보인다.
//  - 'pane'  : ReportSplitLayout 의 각 패널 상단. 보고서 라우트에서만.
export function ReportTabBar({ pane = 'left', placement = 'shell' }) {
  const ctx = useReportTabs()
  const navigate = useNavigate()

  if (pane === 'right') {
    return (
      <TabStrip
        pane="right"
        tabs={ctx.rightTabs}
        activeKey={ctx.rightActiveKey}
        onSelect={(t) => ctx.setRightActive(t.key)}
        onClose={(t) => ctx.closeRight(t.key)}
        onDropKey={(key) => ctx.moveTab(key, 'right')}
      />
    )
  }

  // pane === 'left'
  if (placement === 'shell' && ctx.onReportRoute) return null
  if (placement === 'pane' && !ctx.onReportRoute) return null

  return (
    <TabStrip
      pane="left"
      tabs={ctx.tabs}
      activeKey={ctx.activeKey}
      onSelect={(t) => navigate(routeForTab(t))}
      onClose={(t) => ctx.closeTab(t.key)}
      onDropKey={(key) => ctx.moveTab(key, 'left')}
      // 분할: 활성(편집중) 탭이 아닌 저장된 보고서만 우측으로 보낼 수 있다.
      onSplit={(t) => ctx.moveTab(t.key, 'right')}
      canSplit={(t) => t.key !== ctx.activeKey && Boolean(t.reportId)}
    />
  )
}

function TabStrip({
  pane,
  tabs,
  activeKey,
  onSelect,
  onClose,
  onDropKey,
  onSplit = null,
  canSplit = null,
}) {
  // 드래그가 스트립 위에 있는지(자식 enter/leave 플리커 방지용 카운터).
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)

  if (!tabs || tabs.length === 0) {
    // 우측 패널은 항상 탭이 ≥1(없으면 패널 자체가 안 보임). 좌측 shell/pane 은
    // 빈 경우 숨긴다.
    return null
  }

  function hasTabData(e) {
    return Array.from(e.dataTransfer?.types ?? []).includes(DND_MIME)
  }

  return (
    <div
      data-app-chrome="report-tabs"
      onDragEnter={(e) => {
        if (!hasTabData(e)) return
        dragDepth.current += 1
        setDragOver(true)
      }}
      onDragOver={(e) => {
        if (!hasTabData(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }}
      onDragLeave={(e) => {
        if (!hasTabData(e)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragOver(false)
      }}
      onDrop={(e) => {
        dragDepth.current = 0
        setDragOver(false)
        const raw = e.dataTransfer.getData(DND_MIME)
        if (!raw) return
        e.preventDefault()
        try {
          const { key } = JSON.parse(raw)
          if (key) onDropKey(key)
        } catch {
          /* malformed payload — ignore */
        }
      }}
      className={cn(
        'flex items-stretch gap-1 overflow-x-auto border-b bg-muted/40 px-2 py-1 shrink-0 print:hidden',
        dragOver && 'ring-2 ring-inset ring-primary/50',
      )}
    >
      {tabs.map((tab) => {
        const active = tab.key === activeKey
        const splittable = onSplit && canSplit?.(tab)
        return (
          <div
            key={tab.key}
            role="button"
            tabIndex={0}
            title={tab.title}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData(DND_MIME, JSON.stringify({ key: tab.key, pane }))
            }}
            onClick={() => onSelect(tab)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(tab)
              }
            }}
            className={cn(
              'group flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs cursor-grab active:cursor-grabbing select-none shrink-0 max-w-[200px]',
              active
                ? 'border-border bg-background text-foreground shadow-sm'
                : 'border-transparent bg-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground',
            )}
          >
            <span className="truncate">{tab.title || '불러오는 중…'}</span>
            {splittable && (
              <button
                type="button"
                draggable={false}
                aria-label="오른쪽에 분할로 보기"
                title="오른쪽에 분할로 보기"
                onClick={(e) => {
                  e.stopPropagation()
                  onSplit(tab)
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className="inline-flex h-4 w-4 items-center justify-center rounded shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground opacity-0 group-hover:opacity-70"
              >
                <Columns2 className="h-3 w-3" />
              </button>
            )}
            <button
              type="button"
              draggable={false}
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
