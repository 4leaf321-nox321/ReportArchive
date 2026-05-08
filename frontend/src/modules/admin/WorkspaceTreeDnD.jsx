import * as React from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { GripVertical, ChevronUp, ChevronDown, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { cn } from '@/shared/lib/utils'

/**
 * Drag-and-drop workspace tree.
 *
 * Two drop zones per row:
 *   - "before:slug" — thin band above the row → become previous sibling of slug
 *   - "inside:slug" — the row itself → become last child of slug
 *
 * To make a node the *last* sibling of X, drop it onto X's parent (it
 * becomes that parent's last child). There's no "after" band by design —
 * two zones is enough to reach any tree position with a couple of moves
 * and keeps the visual model simple.
 *
 *   workspaces:  flat list with parent_slug, sort_order, virtual
 *   onMove(plan): array of `{ slug, payload: { parentSlug?, sortOrder? } }`
 *                 — caller batches the PATCH calls.
 *   children footer: <WorkspaceTreeDnD>{(row) => <ActionButtons />}</WorkspaceTreeDnD>
 *                    Lets the parent inject row-level action buttons (edit/delete/↑↓).
 */
export function WorkspaceTreeDnD({ workspaces, onMove, disabled, renderActions }) {
  const real = React.useMemo(() => workspaces.filter((w) => !w.virtual), [workspaces])
  const ordered = React.useMemo(() => orderTreeWithDepth(real), [real])

  const [activeSlug, setActiveSlug] = React.useState(null)
  const [overId, setOverId] = React.useState(null)

  const sensors = useSensors(
    // Require a small drag distance before we start so plain clicks on
    // action buttons don't accidentally trigger a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  const activeWs = activeSlug ? real.find((w) => w.slug === activeSlug) : null

  // Set of slugs the dragged node can't be dropped on (self + descendants),
  // computed only when a drag starts.
  const forbidden = React.useMemo(() => {
    if (!activeSlug) return new Set()
    const set = new Set([activeSlug])
    const byParent = new Map()
    for (const w of real) {
      const arr = byParent.get(w.parent_slug ?? null) ?? []
      arr.push(w)
      byParent.set(w.parent_slug ?? null, arr)
    }
    const stack = [activeSlug]
    while (stack.length) {
      const cur = stack.pop()
      for (const c of byParent.get(cur) ?? []) {
        set.add(c.slug)
        stack.push(c.slug)
      }
    }
    return set
  }, [activeSlug, real])

  function onDragEnd(event) {
    setActiveSlug(null)
    setOverId(null)
    if (!event.over || !event.active) return
    const activeId = event.active.id
    const overParts = String(event.over.id).split(':') // 'before:slug' or 'inside:slug'
    const dropType = overParts[0]
    const targetSlug = overParts.slice(1).join(':')
    if (!dropType || !targetSlug) return

    // Validate
    if (forbidden.has(targetSlug)) return // self or descendant
    const active = real.find((w) => w.slug === activeId)
    const target = real.find((w) => w.slug === targetSlug)
    if (!active || !target) return

    const plan = computeMovePlan({
      active,
      target,
      dropType,
      workspaces: real,
    })
    if (plan.length > 0) onMove(plan)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={(e) => setActiveSlug(String(e.active.id))}
      onDragOver={(e) => setOverId(e.over ? String(e.over.id) : null)}
      onDragCancel={() => {
        setActiveSlug(null)
        setOverId(null)
      }}
      onDragEnd={onDragEnd}
    >
      <ul className="divide-y">
        {ordered.map((w) => {
          const isForbidden = forbidden.has(w.slug)
          return (
            <Row
              key={w.slug}
              ws={w}
              isDraggingThis={activeSlug === w.slug}
              isDragActive={Boolean(activeSlug)}
              isForbidden={isForbidden}
              isOverBefore={overId === `before:${w.slug}` && !isForbidden}
              isOverInside={overId === `inside:${w.slug}` && !isForbidden}
              disabled={disabled}
            >
              {renderActions && renderActions(w)}
            </Row>
          )
        })}
      </ul>

      <DragOverlay>
        {activeWs ? (
          <div className="rounded-md border bg-card shadow-lg px-3 py-2 text-sm flex items-center gap-2">
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: activeWs.color }}
            />
            <span className="font-medium">{activeWs.name}</span>
            <Badge variant="outline" className="font-mono text-[10px]">
              {activeWs.slug}
            </Badge>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function Row({
  ws,
  isDraggingThis,
  isDragActive,
  isForbidden,
  isOverBefore,
  isOverInside,
  disabled,
  children,
}) {
  return (
    <li className="relative">
      <BeforeBand id={`before:${ws.slug}`} active={isOverBefore} disabled={isForbidden} />
      <InsideZone
        id={`inside:${ws.slug}`}
        ws={ws}
        active={isOverInside}
        forbidden={isForbidden}
        isDraggingThis={isDraggingThis}
        isDragActive={isDragActive}
        disabled={disabled}
      >
        {children}
      </InsideZone>
    </li>
  )
}

function BeforeBand({ id, active, disabled }) {
  const { setNodeRef } = useDroppable({ id, disabled })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'h-1 -my-0.5 transition-colors rounded-full',
        active ? 'bg-primary' : 'bg-transparent'
      )}
    />
  )
}

function InsideZone({
  id,
  ws,
  active,
  forbidden,
  isDraggingThis,
  isDragActive,
  disabled,
  children,
}) {
  const { setNodeRef: dropRef } = useDroppable({ id, disabled: disabled || forbidden })
  const {
    setNodeRef: dragRef,
    listeners,
    attributes,
    isDragging,
  } = useDraggable({ id: ws.slug, disabled })

  // Combine the drag and drop refs. dnd-kit needs each to receive its own ref.
  const setNodeRef = React.useCallback(
    (node) => {
      dragRef(node)
      dropRef(node)
    },
    [dragRef, dropRef]
  )

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex items-center gap-2 py-2 px-2 transition-colors rounded-md',
        active && 'bg-primary/10 ring-1 ring-primary/40',
        isDragging && 'opacity-40',
        forbidden && isDragActive && 'opacity-30'
      )}
      style={{ paddingLeft: (ws.depth ?? 0) * 16 + 8 }}
    >
      <button
        type="button"
        {...listeners}
        {...attributes}
        className="cursor-grab active:cursor-grabbing rounded p-1 hover:bg-muted touch-none"
        aria-label="드래그하여 이동"
        disabled={disabled}
      >
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      <span
        className="h-2 w-2 rounded-full shrink-0"
        style={{ backgroundColor: ws.color }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{ws.name}</span>
          <Badge variant="outline" className="font-mono text-[10px]">
            {ws.slug}
          </Badge>
          {ws.parent_slug && (
            <span className="text-[10px] text-muted-foreground">↳ {ws.parent_slug}</span>
          )}
        </div>
        {ws.description && (
          <div className="text-xs text-muted-foreground truncate">{ws.description}</div>
        )}
      </div>
      {children}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Plan computation
// --------------------------------------------------------------------------- //
/**
 * Returns an array of `{ slug, payload }` updates that, when applied, move
 * `active` to its new tree position. The plan re-numbers the *destination*
 * sibling group so the inserted node lands at the requested index. The
 * source group is left with a gap (still sorted correctly).
 */
export function computeMovePlan({ active, target, dropType, workspaces }) {
  const newParent = dropType === 'before' ? target.parent_slug : target.slug
  const newParentKey = newParent ?? null

  const newSiblings = workspaces
    .filter((w) => (w.parent_slug ?? null) === newParentKey && w.slug !== active.slug)
    .sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug))

  let insertIdx
  if (dropType === 'inside') {
    insertIdx = newSiblings.length // append
  } else {
    insertIdx = newSiblings.findIndex((s) => s.slug === target.slug)
    if (insertIdx < 0) insertIdx = newSiblings.length
  }

  const finalOrder = [...newSiblings]
  finalOrder.splice(insertIdx, 0, active)

  const updates = []
  finalOrder.forEach((w, i) => {
    const targetSortOrder = i
    if (w.slug === active.slug) {
      const parentChanged = (active.parent_slug ?? null) !== newParentKey
      const orderChanged = active.sort_order !== targetSortOrder
      if (parentChanged || orderChanged) {
        const payload = { sortOrder: targetSortOrder }
        if (parentChanged) payload.parentSlug = newParent ?? null
        updates.push({ slug: w.slug, payload })
      }
    } else if (w.sort_order !== targetSortOrder) {
      updates.push({ slug: w.slug, payload: { sortOrder: targetSortOrder } })
    }
  })
  return updates
}

function orderTreeWithDepth(workspaces) {
  const byParent = new Map()
  for (const w of workspaces) {
    const arr = byParent.get(w.parent_slug ?? null) ?? []
    arr.push(w)
    byParent.set(w.parent_slug ?? null, arr)
  }
  const out = []
  function walk(parentSlug, depth) {
    const children = byParent.get(parentSlug ?? null) ?? []
    children.sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug))
    for (const c of children) {
      out.push({ ...c, depth })
      walk(c.slug, depth + 1)
    }
  }
  walk(null, 0)
  return out
}
