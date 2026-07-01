import { useEffect, useRef, useState } from 'react'
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
// 드래그드롭:
//  - 같은 패널 안: 드롭 위치로 순서 변경(reorder).
//  - 반대편 패널로: 그 패널로 이동. 한 보고서는 한 패널에만 존재.
//
// placement:
//  - 'shell' : AppShell 콘텐츠 상단. 보고서 라우트가 아닐 때만 보인다.
//  - 'pane'  : ReportSplitLayout 의 각 패널 상단. 보고서 라우트에서만.
export function ReportTabBar({ pane = 'left', placement = 'shell' }) {
  const ctx = useReportTabs()
  const navigate = useNavigate()

  // 같은 패널이면 순서 변경, 반대편이면 패널 이동.
  function handleDrop(key, srcPane, toIndex) {
    if (srcPane === pane) ctx.reorderTab(pane, key, toIndex)
    else ctx.moveTab(key, pane, toIndex)
  }

  if (pane === 'right') {
    return (
      <TabStrip
        pane="right"
        tabs={ctx.rightTabs}
        activeKey={ctx.rightActiveKey}
        onSelect={(t) => ctx.setRightActive(t.key)}
        onClose={(t) => ctx.closeRight(t.key)}
        onDropTab={handleDrop}
        onCloseOthers={(t) => ctx.closeOtherTabs('right', t.key)}
        onCloseToRight={(t) => ctx.closeTabsToRight('right', t.key)}
        onCloseAll={() => ctx.closeAllTabs('right')}
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
      onDropTab={handleDrop}
      onCloseOthers={(t) => ctx.closeOtherTabs('left', t.key)}
      onCloseToRight={(t) => ctx.closeTabsToRight('left', t.key)}
      onCloseAll={() => ctx.closeAllTabs('left')}
      onSplit={(t) => ctx.moveTab(t.key, 'right')}
      // 저장된 보고서만 우측으로. 활성(편집중) 탭은 다른 열린 탭이 있을 때만
      // (옮긴 뒤 편집 창에 그 보고서를 열어야 하므로).
      canSplit={(t) =>
        Boolean(t.reportId) && (t.key !== ctx.activeKey || ctx.tabs.length > 1)
      }
    />
  )
}

function TabStrip({
  pane,
  tabs,
  activeKey,
  onSelect,
  onClose,
  onDropTab,
  onCloseOthers = null,
  onCloseToRight = null,
  onCloseAll = null,
  onSplit = null,
  canSplit = null,
}) {
  // 드롭 삽입 위치(0..tabs.length). null = 드래그 중 아님.
  const [dropHint, setDropHint] = useState(null)
  const dragDepth = useRef(0)
  // 우클릭 컨텍스트 메뉴 — { x, y, tab, index } | null.
  const [menu, setMenu] = useState(null)

  // 메뉴 열림 동안 바깥 클릭·Esc·스크롤·리사이즈로 닫는다.
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  if (!tabs || tabs.length === 0) return null

  function openMenu(e, tab, index) {
    e.preventDefault()
    e.stopPropagation()
    // 대략적인 메뉴 크기로 뷰포트 밖으로 넘치지 않게 보정.
    const MW = 208
    const MH = 176
    const x = Math.min(e.clientX, window.innerWidth - MW - 8)
    const y = Math.min(e.clientY, window.innerHeight - MH - 8)
    setMenu({ x: Math.max(8, x), y: Math.max(8, y), tab, index })
  }

  function hasTabData(e) {
    return Array.from(e.dataTransfer?.types ?? []).includes(DND_MIME)
  }
  function clearHint() {
    dragDepth.current = 0
    setDropHint(null)
  }
  function readDrop(e) {
    const raw = e.dataTransfer.getData(DND_MIME)
    if (!raw) return null
    try {
      const { key, pane: srcPane } = JSON.parse(raw)
      return key ? { key, srcPane } : null
    } catch {
      return null
    }
  }

  return (
    <>
    <div
      data-app-chrome="report-tabs"
      onDragEnter={(e) => {
        if (!hasTabData(e)) return
        dragDepth.current += 1
      }}
      onDragOver={(e) => {
        // 빈 영역 위 — 맨 끝에 삽입(탭 위에선 탭의 핸들러가 stopPropagation).
        if (!hasTabData(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropHint(tabs.length)
      }}
      onDragLeave={(e) => {
        if (!hasTabData(e)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDropHint(null)
      }}
      onDrop={(e) => {
        e.preventDefault()
        const d = readDrop(e)
        clearHint()
        if (d) onDropTab(d.key, d.srcPane, tabs.length)
      }}
      className={cn(
        'flex items-stretch gap-1 overflow-x-auto border-b bg-muted/40 px-2 py-1 shrink-0 print:hidden',
        dropHint != null && 'bg-primary/5',
      )}
    >
      {tabs.map((tab, index) => {
        const active = tab.key === activeKey
        const splittable = onSplit && canSplit?.(tab)
        // 삽입선 — 이 탭 왼쪽(dropHint===index) 또는 맨끝 탭 오른쪽.
        const barLeft = dropHint === index
        const barRight = dropHint === tabs.length && index === tabs.length - 1
        const hintStyle = barLeft
          ? { boxShadow: 'inset 2px 0 0 0 hsl(var(--primary))' }
          : barRight
            ? { boxShadow: 'inset -2px 0 0 0 hsl(var(--primary))' }
            : undefined
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
            onDragOver={(e) => {
              if (!hasTabData(e)) return
              e.preventDefault()
              e.stopPropagation()
              e.dataTransfer.dropEffect = 'move'
              const rect = e.currentTarget.getBoundingClientRect()
              const after = e.clientX > rect.left + rect.width / 2
              setDropHint(index + (after ? 1 : 0))
            }}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const rect = e.currentTarget.getBoundingClientRect()
              const after = e.clientX > rect.left + rect.width / 2
              const toIndex = index + (after ? 1 : 0)
              const d = readDrop(e)
              clearHint()
              if (d) onDropTab(d.key, d.srcPane, toIndex)
            }}
            onClick={() => onSelect(tab)}
            onContextMenu={(e) => openMenu(e, tab, index)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(tab)
              }
            }}
            style={hintStyle}
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
    {menu && (
      <TabContextMenu
        x={menu.x}
        y={menu.y}
        canCloseOthers={tabs.length > 1}
        canCloseToRight={menu.index < tabs.length - 1}
        onClose={() => {
          onClose(menu.tab)
          setMenu(null)
        }}
        onCloseOthers={() => {
          onCloseOthers?.(menu.tab)
          setMenu(null)
        }}
        onCloseToRight={() => {
          onCloseToRight?.(menu.tab)
          setMenu(null)
        }}
        onCloseAll={() => {
          onCloseAll?.()
          setMenu(null)
        }}
      />
    )}
    </>
  )
}

// 탭 우클릭 컨텍스트 메뉴 — 커서 위치에 fixed 로 띄운다(overflow 클리핑 회피).
// 바깥 클릭/Esc/스크롤 닫기는 TabStrip 이 관리하므로 여기선 항목만 렌더.
function TabContextMenu({
  x,
  y,
  canCloseOthers,
  canCloseToRight,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
}) {
  const items = [
    { label: '닫기', onClick: onClose, disabled: false },
    { label: '다른 탭 모두 닫기', onClick: onCloseOthers, disabled: !canCloseOthers },
    { label: '오른쪽 탭 모두 닫기', onClick: onCloseToRight, disabled: !canCloseToRight },
    { sep: true },
    { label: '모두 닫기', onClick: onCloseAll, disabled: false },
  ]
  return (
    <div
      role="menu"
      // 메뉴 위에서의 mousedown 이 바깥-닫기(window mousedown)로 새지 않게 차단.
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: x, top: y }}
      className="fixed z-[60] min-w-[11rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {items.map((it, i) =>
        it.sep ? (
          <div key={`sep-${i}`} className="-mx-1 my-1 h-px bg-muted" />
        ) : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={it.onClick}
            className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            {it.label}
          </button>
        ),
      )}
    </div>
  )
}
