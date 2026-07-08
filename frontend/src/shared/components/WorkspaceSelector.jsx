import * as React from 'react'
import { toast } from 'sonner'
import {
  Check,
  ChevronDown,
  Globe2,
  Star,
  StarOff,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Users,
  Plus,
  Archive,
  ArchiveRestore,
  Maximize2,
} from 'lucide-react'
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
import { useAuth } from '@/shared/auth/AuthContext'
import { setWorkspaceArchived } from '@/shared/api/workspaces'
import { TfCreateDialog } from '@/shared/components/TfCreateDialog'
import { WorkspaceBrowserModal } from '@/shared/components/WorkspaceBrowserModal'
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
  const {
    orgWorkspace,
    switchWorkspace,
    prefs,
    all,
    getPath,
    getDescendantsInclusive,
    reload,
  } = useWorkspace()
  const { me } = useAuth()
  const workspace = orgWorkspace

  // 내 소속(home) 부서 — 하위부서로 내려갈 때 내가 속한 계통을 우선 탄다.
  // home_workspace_slug 가 권위 있는 신호(부서 이동 시 이 값만 갱신). 없으면
  // 첫 비개인 멤버십으로 폴백 — RootRedirect 와 동일한 규칙.
  const homeSlug =
    me?.home_workspace_slug ||
    me?.memberships?.find((m) => !m.workspace_slug?.startsWith('personal-'))
      ?.workspace_slug ||
    null
  const [open, setOpen] = React.useState(false)
  const [createOpen, setCreateOpen] = React.useState(false)
  const [browserOpen, setBrowserOpen] = React.useState(false)

  // TF 개설 성공 후: 목록 갱신 + 새 TF 로 전환.
  const handleTfCreated = React.useCallback(
    async (ws) => {
      await reload()
      if (ws?.slug) switchWorkspace(ws.slug)
    },
    [reload, switchWorkspace],
  )

  // 상하좌우 이동 대상(조직 트리). 상=상위 부서, 하=첫 하위 부서, 좌/우=같은
  // 레벨 형제(sort_order 정렬)의 이전/다음. org·비가상만 대상. ⚠ 훅은 아래
  // early return 위에 둬 호출 순서를 고정.
  const orgs = React.useMemo(
    () => (all ?? []).filter((w) => w.kind === 'org' && !w.virtual),
    [all],
  )
  const nav = React.useMemo(() => {
    const cur = workspace ? orgs.find((w) => w.slug === workspace.slug) : null
    if (!cur) return null
    const byOrder = (a, b) =>
      (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
      (a.name || '').localeCompare(b.name || '')
    const siblings = orgs
      .filter((w) => (w.parent_slug ?? null) === (cur.parent_slug ?? null))
      .sort(byOrder)
    const idx = siblings.findIndex((w) => w.slug === cur.slug)
    const children = orgs.filter((w) => w.parent_slug === cur.slug).sort(byOrder)
    // 하위부서로 내려갈 땐 내 소속(home) 부서가 있는 계통을 우선 탄다. 어떤
    // 자식의 서브트리가 home 을 포함하면 그 자식으로, 없으면 지금처럼 가나다순
    // 첫 자식으로.
    const ownedChild =
      homeSlug != null
        ? children.find((c) =>
            getDescendantsInclusive(c.slug).includes(homeSlug),
          )
        : null
    return {
      up: cur.parent_slug
        ? orgs.find((w) => w.slug === cur.parent_slug) ?? null
        : null,
      down: ownedChild ?? children[0] ?? null,
      left: idx > 0 ? siblings[idx - 1] : null,
      right: idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null,
    }
  }, [orgs, workspace, homeSlug, getDescendantsInclusive])

  // d-pad 영역(또는 선택 버튼)에 포커스가 있고 드롭다운이 닫혀 있을 때,
  // 화살표 키로도 부서를 전환한다.
  function handleArrowKey(e) {
    if (open || !nav) return
    const target = {
      ArrowUp: nav.up,
      ArrowDown: nav.down,
      ArrowLeft: nav.left,
      ArrowRight: nav.right,
    }[e.key]
    if (target === undefined) return // 화살표 키가 아님
    e.preventDefault()
    if (target) switchWorkspace(target.slug)
  }

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
    <div onKeyDown={handleArrowKey}>
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
              {workspace.kind === 'tf' && (
                <span
                  className={cn(
                    'text-[10px] shrink-0',
                    workspace.status === 'archived'
                      ? 'text-amber-600'
                      : 'text-violet-500',
                  )}
                >
                  {workspace.status === 'archived' ? '(TF·보관됨)' : '(TF)'}
                </span>
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
          onRequestCreate={() => {
            setOpen(false)
            setCreateOpen(true)
          }}
          onChanged={reload}
          prefs={prefs}
          all={all}
          getPath={getPath}
        />
      </PopoverContent>
    </Popover>
    <TfCreateDialog
      open={createOpen}
      onOpenChange={setCreateOpen}
      onCreated={handleTfCreated}
    />
    <WorkspaceBrowserModal open={browserOpen} onOpenChange={setBrowserOpen} />
    {/* 상하좌우 부서 이동 d-pad + 확대 버튼(화살표 오른쪽). d-pad 는 nav 가
        있을 때만(조직도 내), 확대 버튼은 항상 노출. */}
    <div className="mt-1.5 flex items-center justify-center gap-1">
      {nav && <WorkspaceDpad nav={nav} onGo={(w) => switchWorkspace(w.slug)} />}
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-7 w-7 shrink-0"
        title="조직도에서 찾기"
        aria-label="조직도에서 찾기"
        onClick={() => setBrowserOpen(true)}
      >
        <Maximize2 className="h-4 w-4" />
      </Button>
    </div>
    </div>
  )
}

/** 부서 이동 십자 버튼. 상=상위, 하=하위, 좌/우=형제. 대상이 없으면 흐리게.
 *  ⚠ HTML `disabled` 대신 `aria-disabled` 를 쓴다 — disabled 버튼은 포커스를
 *  잃어, 끝 부서로 이동해 그 방향이 막히면 이후 화살표 키가 안 먹는다. */
function WorkspaceDpad({ nav, onGo }) {
  function arrow(target, Icon, label) {
    const has = !!target
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn('h-7 w-7', !has && 'opacity-40')}
        aria-disabled={!has}
        title={has ? `${label}: ${target.name}` : `${label} 없음`}
        aria-label={has ? `${label}: ${target.name}` : `${label} 없음`}
        // 화살표 키는 컨테이너 onKeyDown 이 처리 — 버튼 자체 Enter/Space 는 클릭.
        onClick={() => has && onGo(target)}
      >
        <Icon className="h-4 w-4" />
      </Button>
    )
  }
  return (
    <div className="flex w-fit items-center gap-0.5">
      {arrow(nav.left, ArrowLeft, '이전 부서')}
      {arrow(nav.up, ArrowUp, '상위 부서')}
      {arrow(nav.down, ArrowDown, '하위 부서')}
      {arrow(nav.right, ArrowRight, '다음 부서')}
    </div>
  )
}

function WorkspacePicker({
  activeSlug,
  onPick,
  onRequestCreate,
  onChanged,
  prefs,
  all,
  getPath,
}) {
  const [query, setQuery] = React.useState('')
  const [showArchived, setShowArchived] = React.useState(false)
  const trimmed = query.trim().toLowerCase()
  const searching = trimmed.length > 0

  const { buildTree, flattenTree } = useWorkspace()
  const { me } = useAuth()

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

  // TF — 트리 밖 평면. 백엔드가 이미 멤버인 TF 만 내려주므로 all 의 tf 가 곧
  // "내 TF". active/archived 분리(archived 는 토글로만 노출).
  const tfs = React.useMemo(() => all.filter((w) => w.kind === 'tf'), [all])
  const activeTfs = tfs.filter((w) => w.status !== 'archived')
  const archivedTfs = tfs.filter((w) => w.status === 'archived')
  const visibleTfs = showArchived ? tfs : activeTfs

  const slugMap = React.useMemo(() => new Map(all.map((w) => [w.slug, w])), [all])

  // 보직장(org 매니저) 이상이면 TF 개설 버튼 노출(서버도 동일 게이트).
  // is_system_admin 은 me 최상위 플래그(me.user 아님), membership 은
  // workspace_kind 를 직접 실어주므로 slugMap 교차참조 없이 판정한다.
  const isSysAdmin = me?.is_system_admin === true
  const isLead =
    isSysAdmin ||
    (me?.memberships || []).some(
      (m) => m.role === 'manager' && m.workspace_kind === 'org',
    )
  // 이 TF 의 매니저인가(보관/복원 권한) — 직접 멤버십 role 로 판정(상속 없음).
  const tfRoleOf = (slug) =>
    (me?.memberships || []).find((m) => m.workspace_slug === slug)?.role
  const canManageTf = (slug) => isSysAdmin || tfRoleOf(slug) === 'manager'

  async function handleArchiveToggle(ws) {
    const next = ws.status !== 'archived'
    try {
      await setWorkspaceArchived(ws.slug, next)
      toast.success(next ? `'${ws.name}' 보관됨` : `'${ws.name}' 복원됨`)
      onChanged?.()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '변경 실패')
    }
  }
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
            {[...flat, ...virtuals, ...tfs]
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
                  canManage={canManageTf(w.slug)}
                  onArchiveToggle={handleArchiveToggle}
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

            {(visibleTfs.length > 0 || isLead) && (
              <>
                <CommandSeparator />
                <CommandGroup heading="내 TF">
                  {visibleTfs.map((w) => (
                    <PickerRow
                      key={w.slug}
                      ws={w}
                      active={activeSlug === w.slug}
                      pinned={prefs.isPinned(w.slug)}
                      onPick={onPick}
                      onTogglePin={prefs.togglePin}
                      getPath={getPath}
                      canManage={canManageTf(w.slug)}
                      onArchiveToggle={handleArchiveToggle}
                    />
                  ))}
                  {visibleTfs.length === 0 && (
                    <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                      참여 중인 TF가 없습니다.
                    </div>
                  )}
                  {/* 보관된 TF 토글 — 있을 때만 노출. CommandItem 이 아니라
                      일반 버튼이라 cmdk 키보드 탐색에서 빠진다. */}
                  {archivedTfs.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowArchived((v) => !v)}
                      className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-muted rounded"
                    >
                      <Archive className="h-3 w-3" />
                      {showArchived
                        ? '보관된 TF 숨기기'
                        : `보관된 TF 보기 (${archivedTfs.length})`}
                    </button>
                  )}
                  {isLead && (
                    <button
                      type="button"
                      onClick={onRequestCreate}
                      className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[12px] text-primary hover:bg-muted rounded"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      TF 개설
                    </button>
                  )}
                </CommandGroup>
              </>
            )}

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

function PickerRow({
  ws,
  active,
  pinned,
  onPick,
  onTogglePin,
  getPath,
  canManage = false,
  onArchiveToggle,
  showFullPath = false,
}) {
  const depth = ws.depth ?? 0
  const path = showFullPath ? getPath(ws.slug).map((p) => p.name).slice(0, -1).join(' / ') : ''
  const isTf = ws.kind === 'tf'
  const isArchived = ws.status === 'archived'

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
        ) : isTf ? (
          <Users className="h-3.5 w-3.5 shrink-0" style={{ color: ws.color }} />
        ) : (
          <span
            className="h-2 w-2 rounded-full shrink-0"
            style={{ backgroundColor: ws.color }}
          />
        )}
        <div className="flex flex-col min-w-0">
          <span className={cn('truncate text-sm', isArchived && 'text-muted-foreground')}>
            {ws.name}
            {isArchived && (
              <span className="ml-1 text-[10px] text-amber-600">(보관됨)</span>
            )}
          </span>
          {showFullPath && path && (
            <span className="truncate text-[10px] text-muted-foreground">{path}</span>
          )}
        </div>
      </div>

      {active && <Check className="h-4 w-4 text-primary shrink-0" />}

      {isTf && canManage && onArchiveToggle && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onArchiveToggle(ws)
          }}
          className="ml-1 rounded p-1 hover:bg-muted shrink-0"
          aria-label={isArchived ? 'TF 복원' : 'TF 보관'}
          title={isArchived ? 'TF 복원' : 'TF 보관(읽기전용)'}
        >
          {isArchived ? (
            <ArchiveRestore className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <Archive className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>
      )}

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
