import * as React from 'react'
import { Check, ChevronDown, Globe2, Star, StarOff, ChevronRight } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/shared/components/ui/command'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { cn } from '@/shared/lib/utils'

/**
 * Workspace switcher — handles deep org charts (수십 개 부서) by combining:
 *   1. Search (cmdk) — type to filter across all workspaces
 *   2. Pinned + Recent — quick access for power users
 *   3. Tree — show hierarchy for browsing the org chart
 */
export function WorkspaceSelector() {
  // Always display the sticky ORG workspace, never the personal one —
  // the selector represents "which 부서를 보는가" and personal pages
  // are deliberately outside that picker.
  const { orgWorkspace, switchWorkspace, prefs, all, getPath } = useWorkspace()
  const workspace = orgWorkspace
  const [open, setOpen] = React.useState(false)

  if (!workspace) {
    return (
      <Button variant="outline" className="w-full justify-between h-auto py-2" disabled>
        <span className="text-xs text-muted-foreground">부서 로딩 중...</span>
      </Button>
    )
  }

  const path = getPath(workspace.slug)
  const breadcrumb = path
    .slice(0, -1)
    .map((p) => p.name)
    .join(' / ')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="w-full justify-between h-auto py-2"
          title={breadcrumb ? `${breadcrumb} / ${workspace.name}` : workspace.name}
        >
          {/* flex-1 + min-w-0 lets the column actually shrink inside the
              flex button; without them the trigger expands to fit a long
              breadcrumb and overflows the sidebar. */}
          <div className="flex-1 min-w-0 flex flex-col items-start text-left">
            <div className="flex items-center gap-2 w-full min-w-0">
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: workspace.color }}
              />
              <span className="flex-1 min-w-0 truncate text-sm">{workspace.name}</span>
              {workspace.virtual && (
                <span className="text-[10px] text-muted-foreground shrink-0">(횡단)</span>
              )}
            </div>
            {breadcrumb && (
              <span className="block w-full truncate text-[11px] text-muted-foreground pl-4">
                {breadcrumb}
              </span>
            )}
          </div>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <WorkspacePicker
          activeSlug={workspace.slug}
          onPick={(slug) => {
            switchWorkspace(slug)
            setOpen(false)
          }}
          prefs={prefs}
          all={all}
          getPath={getPath}
        />
      </PopoverContent>
    </Popover>
  )
}

function WorkspacePicker({ activeSlug, onPick, prefs, all, getPath }) {
  const [query, setQuery] = React.useState('')
  const trimmed = query.trim().toLowerCase()
  const searching = trimmed.length > 0

  const { buildTree, flattenTree } = useWorkspace()

  // Org picker — personal workspaces are intentionally excluded; they
  // live in the dedicated "내 공간" link above the sidebar's workspace
  // selector. Putting personal alongside org workspaces conflates two
  // different concepts ("선택 가능한 부서" vs "내 작업 영역").
  const tree = React.useMemo(
    () => buildTree({ includeVirtual: false, includePersonal: false }),
    [buildTree]
  )
  const flat = React.useMemo(() => flattenTree(tree), [tree, flattenTree])
  const virtuals = all.filter((w) => w.virtual)

  const slugMap = React.useMemo(() => new Map(all.map((w) => [w.slug, w])), [all])
  // Personal workspaces never belong in the org picker — even if a user
  // had previously landed in their personal space (which pushed it into
  // `recent` or made it pinnable via the old code path), we filter them
  // out here so the picker stays strictly "부서 선택".
  const isPickable = (ws) => ws && ws.kind !== 'personal'
  const findWorkspace = (slug) => {
    const ws = slugMap.get(slug)
    return isPickable(ws) ? ws : null
  }

  const pinned = prefs.pinned.map(findWorkspace).filter(Boolean)
  const recent = prefs.recent
    .filter((s) => !prefs.pinned.includes(s) && s !== activeSlug)
    .map(findWorkspace)
    .filter(Boolean)
    .slice(0, 5)

  function matchesQuery(ws, q) {
    if (!q) return true
    const path = getPath(ws.slug).map((p) => p.name).join(' / ')
    return (
      ws.slug.toLowerCase().includes(q) ||
      ws.name.toLowerCase().includes(q) ||
      path.toLowerCase().includes(q)
    )
  }

  return (
    <Command shouldFilter={false}>
      <CommandInput placeholder="부서 검색..." value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>일치하는 부서가 없습니다.</CommandEmpty>

        {searching ? (
          <CommandGroup heading="검색 결과">
            {[...flat, ...virtuals]
              .filter((w) => matchesQuery(w, trimmed))
              .map((w) => (
                <PickerRow
                  key={w.slug}
                  ws={w}
                  active={activeSlug === w.slug}
                  pinned={prefs.isPinned(w.slug)}
                  onPick={onPick}
                  onTogglePin={prefs.togglePin}
                  getPath={getPath}
                  showFullPath
                />
              ))}
          </CommandGroup>
        ) : (
          <>
            {pinned.length > 0 && (
              <>
                <CommandGroup heading="즐겨찾기">
                  {pinned.map((w) => (
                    <PickerRow
                      key={w.slug}
                      ws={w}
                      active={activeSlug === w.slug}
                      pinned
                      onPick={onPick}
                      onTogglePin={prefs.togglePin}
                      getPath={getPath}
                      showFullPath
                    />
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}

            {recent.length > 0 && (
              <>
                <CommandGroup heading="최근">
                  {recent.map((w) => (
                    <PickerRow
                      key={w.slug}
                      ws={w}
                      active={activeSlug === w.slug}
                      pinned={prefs.isPinned(w.slug)}
                      onPick={onPick}
                      onTogglePin={prefs.togglePin}
                      getPath={getPath}
                      showFullPath
                    />
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}

            <CommandGroup heading="조직도">
              {flat.map((w) => (
                <PickerRow
                  key={w.slug}
                  ws={w}
                  active={activeSlug === w.slug}
                  pinned={prefs.isPinned(w.slug)}
                  onPick={onPick}
                  onTogglePin={prefs.togglePin}
                  getPath={getPath}
                />
              ))}
            </CommandGroup>

            {virtuals.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="횡단">
                  {virtuals.map((w) => (
                    <PickerRow
                      key={w.slug}
                      ws={w}
                      active={activeSlug === w.slug}
                      pinned={prefs.isPinned(w.slug)}
                      onPick={onPick}
                      onTogglePin={prefs.togglePin}
                      getPath={getPath}
                    />
                  ))}
                </CommandGroup>
              </>
            )}
          </>
        )}
      </CommandList>
    </Command>
  )
}

function PickerRow({ ws, active, pinned, onPick, onTogglePin, getPath, showFullPath = false }) {
  const depth = ws.depth ?? 0
  const path = showFullPath ? getPath(ws.slug).map((p) => p.name).slice(0, -1).join(' / ') : ''

  return (
    <CommandItem
      value={`${ws.slug} ${ws.name}`}
      onSelect={() => onPick(ws.slug)}
      className="cursor-pointer"
    >
      <div className="flex items-center gap-1 min-w-0 flex-1" style={{ paddingLeft: depth * 12 }}>
        {!showFullPath && depth > 0 && <ChevronRight className="h-3 w-3 opacity-40 shrink-0" />}
        {ws.virtual ? (
          <Globe2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <span
            className="h-2 w-2 rounded-full shrink-0"
            style={{ backgroundColor: ws.color }}
          />
        )}
        <div className="flex flex-col min-w-0">
          <span className="truncate text-sm">{ws.name}</span>
          {showFullPath && path && (
            <span className="truncate text-[10px] text-muted-foreground">{path}</span>
          )}
        </div>
      </div>

      {active && <Check className="h-4 w-4 text-primary shrink-0" />}

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onTogglePin(ws.slug)
        }}
        className="ml-1 rounded p-1 hover:bg-muted shrink-0"
        aria-label={pinned ? '즐겨찾기 해제' : '즐겨찾기'}
      >
        {pinned ? (
          <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
        ) : (
          <StarOff className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
    </CommandItem>
  )
}
