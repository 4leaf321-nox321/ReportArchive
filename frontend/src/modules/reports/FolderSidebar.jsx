/** 폴더 사이드바 — 개인 공간의 보고서 목록 옆에 노출.
 *
 * 폴더는 본인 소유로만 관리되며 mount/공개 권한과 무관하게 순수
 * 개인 정리용. 기본 폴더 (진행 중 / 종결 / 보관)는 백엔드가 첫 GET
 * 호출 시 자동 생성. 사용자가 임의로 추가/이름변경/삭제 가능.
 *
 * 트리 구조: 다단계 nesting 지원. 클릭 시 onSelect(folderId) — null=전체,
 * 'uncategorized'=폴더 미지정.
 *
 * 이름 변경: 인라인 input (더블 클릭). 추가: 트리 헤더의 +. 삭제:
 * 마우스 오버 시 우측 휴지통.
 */
import * as React from 'react'
import {
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderOpen,
  Inbox,
  Layers3,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import {
  listFolders,
  createFolder,
  updateFolder,
  deleteFolder,
} from '@/shared/api/folders'
import { cn } from '@/shared/lib/utils'

/** Sentinel filter values understood by the parent. */
export const FOLDER_FILTER_ALL = null
export const FOLDER_FILTER_UNCATEGORIZED = 'uncategorized'

/** MIME type carried by a report-row drag. Kept verbatim here (not
 *  imported) so the sidebar doesn't pull a dependency on the list page;
 *  any caller can wire `onReportsDrop` independently as long as their
 *  draggable rows set the same MIME key. Matches the constant in
 *  ReportsListPage.jsx (`REPORT_DRAG_MIME`). */
const REPORT_DRAG_MIME = 'application/x-report-ids'

/** Does `e.dataTransfer` look like a report-row drag (rather than the
 *  folder-tree's own internal folder-on-folder drag)? Checking `types`
 *  is the only reliable read during `dragover` — `getData` returns ""
 *  for security reasons until `drop`. */
function isReportDrag(e) {
  const t = e.dataTransfer?.types
  if (!t) return false
  // DataTransferItemList has a contains() in some browsers but not all;
  // iterate to stay portable.
  for (let i = 0; i < t.length; i++) {
    if (t[i] === REPORT_DRAG_MIME) return true
  }
  return false
}

function readReportIds(e) {
  const raw = e.dataTransfer?.getData(REPORT_DRAG_MIME)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * @param workspaceSlug  Pass the workspace slug for org-scope folders.
 *                       Omit (or undefined) for personal scope.
 * @param canEdit        Whether the current user may CRUD folders in
 *                       this scope. Personal: always true for owner;
 *                       org: true only for workspace admin/manager.
 */
export function FolderSidebar({
  selected,
  onSelect,
  onChanged,
  workspaceSlug,
  canEdit = true,
  // Optional. When provided, folder rows and the "미분류" fixed row also
  // accept drops carrying REPORT_DRAG_MIME — drop fires
  // onReportsDrop(folderIdOrNull, ids). Wiring this is the only opt-in
  // needed for drag-to-move from the report list.
  onReportsDrop,
  // Optional. Each time this changes, the sidebar re-fetches its folder
  // list — used by the parent to refresh per-folder report counts after
  // bulk moves/deletes/unmounts. Folder CRUD inside this component
  // already refreshes via its own `refresh()` calls, so the parent only
  // needs to bump this when reports (not folders) are mutated.
  reloadKey = 0,
}) {
  const [folders, setFolders] = React.useState([])
  const [uncategorizedCount, setUncategorizedCount] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(null)
  // Inline-create state. `creatingUnder = null` means root-level
  // create (the top "+" button); a folder id means "create a child
  // under that folder" (the per-row "+" hover button).
  const [creatingUnder, setCreatingUnder] = React.useState(undefined) // undefined = closed
  const [newName, setNewName] = React.useState('')
  const [renamingId, setRenamingId] = React.useState(null)
  const [renameValue, setRenameValue] = React.useState('')
  const [deleteTarget, setDeleteTarget] = React.useState(null)
  // Track which nodes are expanded. New folders start expanded so the
  // user sees the child they just added. Default: all expanded.
  const [collapsed, setCollapsed] = React.useState(() => new Set())
  // DnD state — `draggingId` is the folder being dragged; `dropTarget`
  // is either a folder id, '__root__' for the root area, or
  // '__uncategorized__' for the 미분류 row (report drops only).
  // Rendered as a highlight on the target.
  const [draggingId, setDraggingId] = React.useState(null)
  const [dropTarget, setDropTarget] = React.useState(null)

  // Catch drag cancellation (ESC, drop on a non-target). The folder-on-
  // folder D&D clears via the source's onDragEnd, but report-row drags
  // start outside this component, so we don't have that hook. Listening
  // on window catches both since dragend bubbles to the top.
  React.useEffect(() => {
    function handleEnd() {
      setDropTarget(null)
    }
    window.addEventListener('dragend', handleEnd)
    return () => window.removeEventListener('dragend', handleEnd)
  }, [])

  const refresh = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { items, uncategorized_count } = await listFolders({
        workspaceSlug,
      })
      setFolders(items)
      setUncategorizedCount(uncategorized_count)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [workspaceSlug])

  React.useEffect(() => {
    refresh()
    // reloadKey 는 보고서 mutation 후 부모가 bump 하는 외부 트리거 —
    // refresh 자체는 안 바뀌지만 effect 가 재실행되어 카운트가 새로
    // 받아온다.
  }, [refresh, reloadKey])

  // Build a parent → children index for nesting.
  const childrenOf = React.useMemo(() => {
    const map = new Map()
    for (const f of folders) {
      const key = f.parent_id ?? null
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(f)
    }
    return map
  }, [folders])

  const totalReports = folders.reduce(
    (sum, f) => sum + (f.report_count || 0),
    0,
  )

  async function handleCreate() {
    const name = newName.trim()
    if (!name) {
      setCreatingUnder(undefined)
      return
    }
    const parentId = creatingUnder ?? null
    try {
      await createFolder({ name, parentId, workspaceSlug })
      setNewName('')
      setCreatingUnder(undefined)
      // Make sure the parent is expanded so the new child is visible.
      if (parentId != null) {
        setCollapsed((prev) => {
          const next = new Set(prev)
          next.delete(parentId)
          return next
        })
      }
      await refresh()
      onChanged?.()
      toast.success(`폴더 추가: ${name}`)
    } catch (e) {
      toast.error(e?.response?.data?.message || '폴더 추가 실패')
    }
  }

  function toggleCollapsed(id) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** Returns the set of ids that include `id` and all its descendants
   *  — used to forbid drops that would create a cycle (moving a
   *  folder under itself or its own subtree). */
  function descendantsOf(id) {
    const out = new Set([id])
    const stack = [id]
    while (stack.length) {
      const cur = stack.pop()
      for (const child of childrenOf.get(cur) ?? []) {
        if (!out.has(child.id)) {
          out.add(child.id)
          stack.push(child.id)
        }
      }
    }
    return out
  }

  /** Is `targetId` a legal drop target for the currently-dragged
   *  folder? targetId === '__root__' means "drop on the root area". */
  function canDropOn(targetId) {
    if (draggingId == null) return false
    if (targetId === '__root__') {
      // Root drop is illegal only if the folder is already at root —
      // that just becomes a no-op silently, but we hide the highlight.
      const dragging = folders.find((f) => f.id === draggingId)
      return dragging != null && dragging.parent_id != null
    }
    if (targetId === draggingId) return false
    // Forbid drop onto self or any descendant — would create a cycle.
    const forbidden = descendantsOf(draggingId)
    return !forbidden.has(targetId)
  }

  async function handleDrop(targetId) {
    if (!canDropOn(targetId)) {
      setDraggingId(null)
      setDropTarget(null)
      return
    }
    const newParentId = targetId === '__root__' ? null : targetId
    try {
      await updateFolder(draggingId, { parentId: newParentId })
      // Expand the new parent so the moved folder is visible.
      if (newParentId != null) {
        setCollapsed((prev) => {
          const next = new Set(prev)
          next.delete(newParentId)
          return next
        })
      }
      await refresh()
      onChanged?.()
    } catch (e) {
      toast.error(e?.response?.data?.message || '폴더 이동 실패')
    } finally {
      setDraggingId(null)
      setDropTarget(null)
    }
  }

  async function handleRename(id) {
    const name = renameValue.trim()
    if (!name) {
      setRenamingId(null)
      return
    }
    try {
      await updateFolder(id, { name })
      setRenamingId(null)
      await refresh()
      onChanged?.()
    } catch (e) {
      toast.error(e?.response?.data?.message || '이름 변경 실패')
    }
  }

  async function handleDelete(folder) {
    try {
      await deleteFolder(folder.id)
      // If the user was viewing the now-deleted folder, fall back to "전체".
      if (selected === folder.id) onSelect(FOLDER_FILTER_ALL)
      await refresh()
      onChanged?.()
      toast.success(`폴더 삭제: ${folder.name}`)
    } catch (e) {
      toast.error(e?.response?.data?.message || '폴더 삭제 실패')
    } finally {
      setDeleteTarget(null)
    }
  }

  function renderNode(folder, depth) {
    const children = childrenOf.get(folder.id) ?? []
    const isActive = selected === folder.id
    const isRenaming = renamingId === folder.id
    const isCollapsed = collapsed.has(folder.id)
    const hasChildren = children.length > 0
    const isDragging = draggingId === folder.id
    // dropTarget is only set after a valid drag-source check (folder or
    // report), so the simple equality is enough — no need to re-run
    // canDropOn, which only knows about folder drags and would return
    // false during a report-row drag.
    const isDropHere = dropTarget === folder.id
    return (
      <div key={folder.id}>
        <div
          draggable={canEdit && !isRenaming}
          onDragStart={
            canEdit
              ? (e) => {
                  e.stopPropagation()
                  e.dataTransfer.effectAllowed = 'move'
                  // Some browsers require setData for drag to start.
                  e.dataTransfer.setData('text/plain', String(folder.id))
                  setDraggingId(folder.id)
                }
              : undefined
          }
          onDragEnd={
            canEdit
              ? () => {
                  setDraggingId(null)
                  setDropTarget(null)
                }
              : undefined
          }
          onDragOver={(e) => {
            // Report-row drop has priority — accept regardless of
            // canEdit because moving a report into a folder is a
            // separate permission from CRUDing folders themselves.
            if (onReportsDrop && isReportDrag(e)) {
              e.preventDefault()
              e.stopPropagation()
              e.dataTransfer.dropEffect = 'move'
              if (dropTarget !== folder.id) setDropTarget(folder.id)
              return
            }
            if (canEdit && canDropOn(folder.id)) {
              e.preventDefault()
              e.stopPropagation()
              e.dataTransfer.dropEffect = 'move'
              if (dropTarget !== folder.id) setDropTarget(folder.id)
            }
          }}
          onDragLeave={(e) => {
            // Only clear if we're leaving the row itself, not entering
            // a child element.
            if (e.currentTarget === e.target) {
              if (dropTarget === folder.id) setDropTarget(null)
            }
          }}
          onDrop={(e) => {
            if (onReportsDrop && isReportDrag(e)) {
              e.preventDefault()
              e.stopPropagation()
              const ids = readReportIds(e)
              setDropTarget(null)
              if (ids?.length) onReportsDrop(folder.id, ids)
              return
            }
            if (canEdit) {
              e.preventDefault()
              e.stopPropagation()
              handleDrop(folder.id)
            }
          }}
          className={cn(
            'group flex items-center gap-1 rounded-md px-1.5 py-1 text-sm cursor-pointer transition-colors',
            isDragging && 'opacity-50',
            isDropHere && 'ring-1 ring-primary bg-primary/10',
            !isDropHere && isActive
              ? 'bg-primary/10 text-primary font-medium'
              : !isDropHere && 'hover:bg-muted text-foreground/80',
          )}
          style={{ paddingLeft: 6 + depth * 10 }}
          onClick={() => !isRenaming && onSelect(folder.id)}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                toggleCollapsed(folder.id)
              }}
              className="p-0.5 hover:bg-background rounded shrink-0"
              aria-label={isCollapsed ? '펼치기' : '접기'}
            >
              {isCollapsed ? (
                <ChevronRight className="h-3 w-3 opacity-60" />
              ) : (
                <ChevronDown className="h-3 w-3 opacity-60" />
              )}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          {isActive ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          ) : (
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          {isRenaming ? (
            <Input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => handleRename(folder.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename(folder.id)
                if (e.key === 'Escape') setRenamingId(null)
              }}
              className="h-6 text-xs px-1.5"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              <span
                className="flex-1 truncate"
                title={folder.name}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  setRenameValue(folder.name)
                  setRenamingId(folder.id)
                }}
              >
                {folder.name}
              </span>
              <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                {folder.report_count || 0}
              </span>
              {canEdit && (
                <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5">
                  <button
                    type="button"
                    className="p-0.5 hover:bg-background rounded"
                    onClick={(e) => {
                      e.stopPropagation()
                      setNewName('')
                      setCreatingUnder(folder.id)
                      setCollapsed((prev) => {
                        const next = new Set(prev)
                        next.delete(folder.id)
                        return next
                      })
                    }}
                    title="하위 폴더 추가"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    className="p-0.5 hover:bg-background rounded"
                    onClick={(e) => {
                      e.stopPropagation()
                      setRenameValue(folder.name)
                      setRenamingId(folder.id)
                    }}
                    title="이름 변경"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    className="p-0.5 hover:bg-background rounded text-destructive"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeleteTarget(folder)
                    }}
                    title="삭제"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Inline-create input rendered as a pseudo-child of this folder. */}
        {creatingUnder === folder.id && (
          <InlineCreateRow
            depth={depth + 1}
            value={newName}
            onChange={setNewName}
            onSubmit={handleCreate}
            onCancel={() => {
              setNewName('')
              setCreatingUnder(undefined)
            }}
          />
        )}

        {!isCollapsed && children.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  const roots = childrenOf.get(null) ?? []

  const isRootDropTarget = dropTarget === '__root__' && canDropOn('__root__')

  return (
    <div className="w-64 shrink-0 border-r bg-muted/30 flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          폴더
        </span>
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setNewName('')
              setCreatingUnder(
                creatingUnder === null ? undefined : null,
              )
            }}
            className="p-1 hover:bg-background rounded"
            title="새 폴더 (최상위)"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div
        className={cn(
          'flex-1 overflow-y-auto overflow-x-auto p-1.5 space-y-0.5',
          isRootDropTarget && 'ring-1 ring-primary/40 ring-inset',
        )}
        onDragOver={
          canEdit
            ? (e) => {
                if (canDropOn('__root__')) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (dropTarget !== '__root__') setDropTarget('__root__')
                }
              }
            : undefined
        }
        onDragLeave={(e) => {
          if (e.currentTarget === e.target && dropTarget === '__root__') {
            setDropTarget(null)
          }
        }}
        onDrop={
          canEdit
            ? (e) => {
                e.preventDefault()
                handleDrop('__root__')
              }
            : undefined
        }
      >
        {/* 항상 보이는 두 fixed 항목 — 전체 / 미분류 */}
        <FixedRow
          icon={Layers3}
          label="전체"
          count={totalReports + uncategorizedCount}
          active={selected === FOLDER_FILTER_ALL}
          onClick={() => onSelect(FOLDER_FILTER_ALL)}
        />
        {/* "미분류" — folder_id=null 자리. 보고서 행을 여기로 드래그하면
            폴더에서 빼낸다. "전체" 는 필터일 뿐이라 drop 대상으로 두지
            않는다 (방향이 모호). */}
        <FixedRow
          icon={Inbox}
          label="미분류"
          count={uncategorizedCount}
          active={selected === FOLDER_FILTER_UNCATEGORIZED}
          onClick={() => onSelect(FOLDER_FILTER_UNCATEGORIZED)}
          isDropHere={dropTarget === '__uncategorized__'}
          onDragOver={
            onReportsDrop
              ? (e) => {
                  if (isReportDrag(e)) {
                    e.preventDefault()
                    e.stopPropagation()
                    e.dataTransfer.dropEffect = 'move'
                    if (dropTarget !== '__uncategorized__')
                      setDropTarget('__uncategorized__')
                  }
                }
              : undefined
          }
          onDragLeave={
            onReportsDrop
              ? (e) => {
                  if (
                    e.currentTarget === e.target &&
                    dropTarget === '__uncategorized__'
                  ) {
                    setDropTarget(null)
                  }
                }
              : undefined
          }
          onDrop={
            onReportsDrop
              ? (e) => {
                  if (!isReportDrag(e)) return
                  e.preventDefault()
                  e.stopPropagation()
                  const ids = readReportIds(e)
                  setDropTarget(null)
                  if (ids?.length) onReportsDrop(null, ids)
                }
              : undefined
          }
        />

        <div className="h-px bg-border my-1.5" />

        {loading ? (
          <div className="flex items-center justify-center py-4 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          </div>
        ) : error ? (
          <div className="text-xs text-destructive px-2 py-1">{error}</div>
        ) : (
          <>
            {roots.map((f) => renderNode(f, 0))}
            {creatingUnder === null && (
              <InlineCreateRow
                depth={0}
                value={newName}
                onChange={setNewName}
                onSubmit={handleCreate}
                onCancel={() => {
                  setNewName('')
                  setCreatingUnder(undefined)
                }}
              />
            )}
            {/* Spacer at the bottom of the tree so drops on the
                'empty space' area also count as root drops (the parent
                div's onDrop catches it). Visual feedback comes from the
                container ring when the root is a legal target. */}
            {draggingId != null && (
              <div className="h-8" />
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title="폴더 삭제"
        description={
          deleteTarget
            ? `'${deleteTarget.name}' 폴더를 삭제합니다. 안의 보고서는 '미분류'로 이동합니다. (하위 폴더는 함께 삭제됩니다.)`
            : ''
        }
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={() => deleteTarget && handleDelete(deleteTarget)}
      />
    </div>
  )
}

function InlineCreateRow({ depth, value, onChange, onSubmit, onCancel }) {
  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span className="w-4 shrink-0" />
      <FolderIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <Input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit()
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="폴더 이름"
        className="h-6 text-xs px-1.5"
      />
      <button type="button" onClick={onCancel} className="p-0.5">
        <X className="h-3 w-3 text-muted-foreground" />
      </button>
    </div>
  )
}

function FixedRow({
  icon: Icon,
  label,
  count,
  active,
  onClick,
  isDropHere,
  onDragOver,
  onDragLeave,
  onDrop,
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2 py-1 text-sm cursor-pointer transition-colors',
        isDropHere && 'ring-1 ring-primary bg-primary/10',
        !isDropHere && active
          ? 'bg-primary/10 text-primary font-medium'
          : !isDropHere && 'hover:bg-muted text-foreground/80',
      )}
      onClick={onClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className="w-3 shrink-0" />
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
          {count}
        </span>
      )}
    </div>
  )
}
