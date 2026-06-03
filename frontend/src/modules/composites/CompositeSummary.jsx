import { useEffect, useMemo, useRef, useState } from 'react'
import GridLayout from 'react-grid-layout'
import {
  Plus,
  Trash2,
  GripVertical,
  Settings2,
  Pencil,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { cn } from '@/shared/lib/utils'
import { getRenderer } from '@/modules/templates/widgets'
import { WidgetPicker } from '@/modules/templates/WidgetPicker'
import { useWidgetCatalog } from '@/shared/hooks/useWidgetCatalog'

const COLS = 12
const ROW_HEIGHT = 24

// 카드에서 곧바로 인라인 편집하는 위젯 — 문서 흐름과 밀착돼 인라인이 자연스러운
// "긴 글(rich_text)"·"제목(heading)"만. 그 외 위젯은 보고서와 동일하게 편집
// 모드에서도 읽기 전용으로 두고, 카드를 클릭하면 모달 편집기로 들어간다.
const INLINE_EDITABLE_WIDGETS = new Set(['rich_text', 'heading'])

function newId() {
  return `w_${Math.random().toString(36).slice(2, 10)}`
}

/** 종합보고 요약 페이지 — free-form 위젯을 12열 그리드로 배치/편집.
 *  보고서의 PageSection 은 재사용하지 않고, 위젯 렌더러(getRenderer) 위에
 *  react-grid-layout 을 얇게 얹었다. widgets: [{id,type,props,content,layout}].
 */
export function CompositeSummary({ widgets, editing, onChange }) {
  const { catalog } = useWidgetCatalog()
  const list = useMemo(() => widgets ?? [], [widgets])

  const containerRef = useRef(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const [settingsTarget, setSettingsTarget] = useState(null)
  const [contentTarget, setContentTarget] = useState(null)

  const rglLayout = useMemo(
    () =>
      list.map((w) => ({
        i: w.id,
        x: w.layout?.x ?? 0,
        y: w.layout?.y ?? 0,
        w: w.layout?.w ?? COLS,
        h: w.layout?.h ?? 6,
        minW: 2,
        minH: 2,
      })),
    [list],
  )

  function updateWidget(id, patch) {
    onChange(list.map((w) => (w.id === id ? { ...w, ...patch } : w)))
  }
  function removeWidget(id) {
    onChange(list.filter((w) => w.id !== id))
  }
  function addWidget(type) {
    const meta = catalog?.byType?.[type]
    const maxY = list.reduce(
      (m, w) => Math.max(m, (w.layout?.y ?? 0) + (w.layout?.h ?? 6)),
      0,
    )
    onChange([
      ...list,
      {
        id: newId(),
        type,
        props: { ...(meta?.default_props ?? {}) },
        content: {},
        layout: { x: 0, y: maxY, w: COLS, h: 6 },
      },
    ])
  }
  /** 기존 위젯 카드의 호버 화살표로 그 위젯을 기준으로 새 위젯을 끼워넣는다
   *  (보고서의 DirectionalAddArrows 와 동일한 UX). 세로(up/down)는 전폭으로
   *  넣고 아래 위젯들을 밀어내며, 가로(left/right)는 대상 칸을 절반으로 쪼개
   *  나란히 배치한다. RGL 의 vertical 압축이 빈틈을 정리해 준다. */
  function insertWidget(type, defaults, direction, targetId) {
    const target = list.find((w) => w.id === targetId)
    if (!target) return addWidget(type)
    const t = target.layout ?? { x: 0, y: 0, w: COLS, h: 6 }
    const fresh = {
      id: newId(),
      type,
      props: { ...(defaults ?? {}) },
      content: {},
    }
    if (direction === 'up' || direction === 'down') {
      const newH = 6
      const baseY = direction === 'up' ? t.y : t.y + t.h
      const shifted = list.map((w) =>
        (w.layout?.y ?? 0) >= baseY
          ? { ...w, layout: { ...w.layout, y: (w.layout?.y ?? 0) + newH } }
          : w,
      )
      onChange([
        ...shifted,
        { ...fresh, layout: { x: t.x, y: baseY, w: t.w, h: newH } },
      ])
      return
    }
    // left / right — 대상 칸을 절반으로 쪼개 나란히.
    const half = Math.max(2, Math.floor(t.w / 2))
    const rest = Math.max(2, t.w - half)
    if (direction === 'left') {
      const shifted = list.map((w) =>
        w.id === targetId
          ? { ...w, layout: { ...t, x: t.x + half, w: rest } }
          : w,
      )
      onChange([
        ...shifted,
        { ...fresh, layout: { x: t.x, y: t.y, w: half, h: t.h } },
      ])
    } else {
      const shifted = list.map((w) =>
        w.id === targetId ? { ...w, layout: { ...t, w: rest } } : w,
      )
      onChange([
        ...shifted,
        { ...fresh, layout: { x: t.x + rest, y: t.y, w: half, h: t.h } },
      ])
    }
  }

  function onLayoutChange(next) {
    const byId = new Map(next.map((l) => [l.i, l]))
    onChange(
      list.map((w) => {
        const l = byId.get(w.id)
        return l ? { ...w, layout: { x: l.x, y: l.y, w: l.w, h: l.h } } : w
      }),
    )
  }

  // 보기 모드 + 비어 있으면 섹션 자체를 숨김(편집 모드에선 추가 UI 노출).
  if (!editing && list.length === 0) return null

  return (
    <div ref={containerRef}>
      {editing && (
        <div className="mb-2 flex items-center gap-2">
          <WidgetPalette catalog={catalog} onAdd={addWidget} />
          <span className="text-[11px] text-muted-foreground">
            긴 글·제목은 카드에서 바로 입력 · 그 외 위젯은 클릭해 편집 · 끌어
            배치하고 모서리로 크기 조절 · 호버 시 화살표로 새 위젯 추가
          </span>
        </div>
      )}

      {list.length === 0 ? (
        <p className="rounded-md border border-dashed py-6 text-center text-[13px] text-muted-foreground">
          요약 위젯이 없습니다 — 위 “위젯 추가”로 시작하세요.
        </p>
      ) : (
        <GridLayout
          className="composite-summary-grid"
          cols={COLS}
          rowHeight={ROW_HEIGHT}
          width={width || 800}
          layout={rglLayout}
          isDraggable={editing}
          isResizable={editing}
          onLayoutChange={editing ? onLayoutChange : undefined}
          draggableHandle=".summary-widget-drag"
          compactType="vertical"
          margin={[8, 8]}
          isBounded
        >
          {list.map((w) => (
            <div
              key={w.id}
              className={cn('min-h-0', editing && 'group/insert relative')}
            >
              <SummaryWidgetCard
                widget={w}
                editing={editing}
                hasSettings={!!getRenderer(w.type)?.PropsPanel}
                onChangeContent={(content) => updateWidget(w.id, { content })}
                onOpenContent={() => setContentTarget(w)}
                onOpenSettings={() => setSettingsTarget(w)}
                onRemove={() => removeWidget(w.id)}
              />
              {editing && (
                <DirectionalAddArrows
                  catalog={catalog}
                  canInsertHorizontally={(w.layout?.w ?? COLS) >= 4}
                  onAdd={(type, defaults, direction) =>
                    insertWidget(type, defaults, direction, w.id)
                  }
                />
              )}
            </div>
          ))}
        </GridLayout>
      )}

      {contentTarget && (
        <SummaryWidgetContentDialog
          widget={contentTarget}
          label={
            catalog?.byType?.[contentTarget.type]?.label ?? contentTarget.type
          }
          onClose={() => setContentTarget(null)}
          onApply={({ content, props }) => {
            updateWidget(contentTarget.id, { content, props })
            setContentTarget(null)
          }}
        />
      )}

      {settingsTarget && (
        <SummaryWidgetSettingsDialog
          widget={settingsTarget}
          label={
            catalog?.byType?.[settingsTarget.type]?.label ?? settingsTarget.type
          }
          onClose={() => setSettingsTarget(null)}
          onApply={(props) => {
            updateWidget(settingsTarget.id, { props })
            setSettingsTarget(null)
          }}
        />
      )}
    </div>
  )
}

function SummaryWidgetCard({
  widget,
  editing,
  hasSettings,
  onChangeContent,
  onOpenContent,
  onOpenSettings,
  onRemove,
}) {
  const renderer = getRenderer(widget.type)
  const Editor = renderer?.Editor
  // 보고서와 동일한 규칙: 긴 글·제목만 카드에서 인라인 편집, 나머지는 편집
  // 모드에서도 읽기 전용으로 두고 카드 클릭 시 모달 편집기로 들어간다.
  const isInline = INLINE_EDITABLE_WIDGETS.has(widget.type)
  const editorReadOnly = !editing || !isInline
  const opensModal = editing && !isInline
  return (
    <div
      className={cn(
        'group/card relative flex h-full min-h-0 flex-col overflow-hidden rounded-md border bg-card',
        opensModal && 'hover:ring-2 hover:ring-primary/20',
      )}
      // 비인라인 위젯은 더블클릭으로도 편집창을 연다(보고서와 동일). 단일
      // 클릭/드래그/리사이즈와 분리돼 실수로 열리지 않는다.
      onDoubleClick={opensModal ? onOpenContent : undefined}
    >
      {editing && (
        <div className="flex items-center gap-1 border-b bg-muted/30 px-1.5 py-0.5">
          <span className="summary-widget-drag flex cursor-grab items-center text-muted-foreground active:cursor-grabbing">
            <GripVertical className="h-3.5 w-3.5" />
          </span>
          <span className="flex-1" />
          {hasSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              title="위젯 설정 (라벨·열 등)"
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            title="위젯 삭제"
            className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {/* 호버 시 떠오르는 "편집" 버튼 — 비인라인 위젯의 모달 진입점.
          오버레이는 pointer-events-none, 버튼만 pointer-events-auto. */}
      {opensModal && (
        <div className="pointer-events-none absolute inset-0 z-[6] flex items-center justify-center bg-background/10 opacity-0 transition-opacity group-hover/card:opacity-100">
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onOpenContent()
            }}
            className="pointer-events-auto inline-flex items-center gap-2 rounded-lg border-2 border-primary bg-background px-5 py-2.5 text-sm font-semibold text-primary shadow-lg hover:bg-primary hover:text-primary-foreground"
            title="이 위젯 편집 (더블클릭으로도 열림)"
          >
            <Pencil className="h-4 w-4" />
            편집
          </button>
        </div>
      )}
      <div className="report-widget-body min-h-0 flex-1 overflow-auto p-2">
        {Editor ? (
          <Editor
            props={widget.props ?? {}}
            content={widget.content ?? {}}
            onChange={editorReadOnly ? () => {} : onChangeContent}
            readOnly={editorReadOnly}
          />
        ) : (
          <p className="text-[11px] text-destructive">
            알 수 없는 위젯: {widget.type}
          </p>
        )}
      </div>
    </div>
  )
}

/** 비인라인 위젯(차트·표 등)의 "내용 편집" 모달 — 보고서의 WidgetContentEditDialog
 *  와 같은 역할. 80vw/80vh 의 넉넉한 편집 영역에서 위젯 Editor 를 readOnly=false
 *  로 띄운다. content 와, 위젯이 스스로 바꾸는 props(차트 등)를 버퍼링했다가
 *  "적용" 시 한꺼번에 반영한다(취소 시 아무 변화 없음). */
function SummaryWidgetContentDialog({ widget, label, onClose, onApply }) {
  const renderer = getRenderer(widget.type)
  const Editor = renderer?.Editor
  const [content, setContent] = useState(widget.content ?? {})
  const [props, setProps] = useState(widget.props ?? {})
  if (!Editor) return null
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex w-[80vw] max-w-[80vw] flex-col overflow-hidden sm:max-w-[80vw]"
        style={{ height: '80vh', maxHeight: '80vh' }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4" />
            위젯 편집 — {label}
          </DialogTitle>
        </DialogHeader>
        <div className="report-widget-body flex min-h-0 flex-1 flex-col">
          <Editor
            props={props}
            content={content}
            onChange={setContent}
            onChangePropsOverride={(patch) =>
              setProps((p) => ({ ...p, ...(patch ?? {}) }))
            }
            autoFit={false}
            readOnly={false}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button onClick={() => onApply({ content, props })}>적용</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 위젯 "설정"(라벨·열 수 등 props) 전용 모달. 내용 편집은 카드에서 인라인
 *  으로 하므로 여기서는 PropsPanel 만 다룬다(보고서의 속성 편집과 동일 역할). */
function SummaryWidgetSettingsDialog({ widget, label, onClose, onApply }) {
  const renderer = getRenderer(widget.type)
  const [props, setProps] = useState(widget.props ?? {})
  const PropsPanel = renderer?.PropsPanel
  if (!PropsPanel) return null
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-[80vw] max-w-xl flex-col">
        <DialogHeader>
          <DialogTitle>위젯 설정 — {label}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PropsPanel props={props} onChange={setProps} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button onClick={() => onApply(props)}>적용</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 위젯 카드에 호버하면 상/하/좌/우 가장자리에 떠오르는 "+ 추가" 화살표.
 *  화살표를 누르면 위젯 카탈로그 팝오버가 열리고, 고른 위젯을 그 방향에
 *  끼워넣는다. 보고서 본문의 DirectionalAddArrows 와 같은 조작감. */
function DirectionalAddArrows({ catalog, canInsertHorizontally, onAdd }) {
  const widgets = catalog?.widgets ?? []
  const [open, setOpen] = useState(null) // 'up'|'down'|'left'|'right'|null
  if (widgets.length === 0) return null

  function Arrow({ direction, icon: Icon, positionClass, side }) {
    return (
      <Popover
        open={open === direction}
        onOpenChange={(o) => setOpen(o ? direction : null)}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            title="이 방향에 위젯 추가"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'absolute z-20 flex h-6 w-6 items-center justify-center rounded-full',
              'border bg-background text-muted-foreground shadow-sm',
              'opacity-0 transition-opacity pointer-events-none',
              'hover:bg-primary hover:text-primary-foreground hover:border-primary',
              'group-hover/insert:opacity-100 group-hover/insert:pointer-events-auto',
              positionClass,
            )}
          >
            <Icon className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side={side}
          align="center"
          sideOffset={6}
          className="w-[760px] max-w-[92vw] p-2 max-h-[70vh] overflow-y-auto"
        >
          <WidgetPicker
            widgets={widgets}
            onSelect={(w) => {
              onAdd(w.type, w.default_props ?? {}, direction)
              setOpen(null)
            }}
          />
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <>
      <Arrow
        direction="up"
        icon={ChevronUp}
        positionClass="-top-3 left-1/2 -translate-x-1/2"
        side="top"
      />
      <Arrow
        direction="down"
        icon={ChevronDown}
        positionClass="-bottom-3 left-1/2 -translate-x-1/2"
        side="bottom"
      />
      {canInsertHorizontally && (
        <Arrow
          direction="left"
          icon={ChevronLeft}
          positionClass="top-1/2 -left-3 -translate-y-1/2"
          side="left"
        />
      )}
      {canInsertHorizontally && (
        <Arrow
          direction="right"
          icon={ChevronRight}
          positionClass="top-1/2 -right-3 -translate-y-1/2"
          side="right"
        />
      )}
    </>
  )
}

function WidgetPalette({ catalog, onAdd }) {
  const widgets = catalog?.widgets ?? []
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" disabled={widgets.length === 0}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          위젯 추가
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {widgets.map((w) => (
          <DropdownMenuItem key={w.type} onClick={() => onAdd(w.type)}>
            {w.label ?? w.type}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
