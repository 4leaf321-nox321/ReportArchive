/** 게시 다이얼로그 — 보고서를 조직 게시판에 link.
 *
 * Personal 공간의 보고서를 N개 조직 게시판에 동시에 게시/해제. 사용자가
 * 멤버인 org 워크스페이스만 노출. 이미 게시된 게시판은 체크 상태로 표시,
 * 해제도 같은 다이얼로그에서 가능.
 *
 * 권한 모델 (Phase 1): 작성자 본인만 게시/해제 가능 (Phase 3에서 보직장
 * 자동 권한 추가). Edit policy preset은 Phase 3에서 노출 — Phase 1은 모두
 * `default`로 고정.
 */
import * as React from 'react'
import {
  Check,
  Loader2,
  Building2,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Search,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Textarea } from '@/shared/components/ui/textarea'
import { toast } from 'sonner'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAuth } from '@/shared/auth/AuthContext'
import {
  listMounts,
  mountReport,
  unmountReport,
  setMountFolder,
  setMountEditPolicy,
} from '@/shared/api/mounts'
import { FolderPickerButton } from './FolderPickerButton'
import { cn } from '@/shared/lib/utils'

/** Edit policy options for the per-mount dropdown. The short labels go
 *  on the chip; the descriptions appear in the dropdown row + tooltip
 *  so users learn the semantics without a separate help page. */
const POLICY_OPTIONS = [
  {
    value: 'default',
    label: '기본',
    description: '작성자 + 보직장 편집 가능',
  },
  {
    value: 'owner_only',
    label: '작성자 전용',
    description: '보직장도 차단, 작성자만 편집',
  },
  {
    value: 'coauthor',
    label: '공동 작성',
    description: '게시판 멤버 누구나 편집',
  },
]
const POLICY_BY_VALUE = Object.fromEntries(
  POLICY_OPTIONS.map((o) => [o.value, o]),
)

export function MountDialog({ open, onOpenChange, report, onChanged }) {
  const { all, getDescendantsInclusive, getAncestors, getPath } = useWorkspace()
  const { me } = useAuth()

  const [mounts, setMounts] = React.useState([])
  const [pending, setPending] = React.useState({}) // slug → 'mounting' | 'unmounting'
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [note, setNote] = React.useState('')
  const isOwner = me?.user?.id && report?.owner_user_id === me.user.id

  // Eligible boards = org workspaces the user can publish to.
  // Mirrors the backend's ancestor-walk permission check: membership
  // at a parent (e.g. 본부) grants publish rights to every descendant
  // team. So we union descendants of every direct org membership.
  const eligibleSlugs = React.useMemo(() => {
    const set = new Set()
    for (const m of me?.memberships ?? []) {
      const slug = m.workspace_slug
      if (!slug || slug.startsWith('personal-')) continue
      for (const s of getDescendantsInclusive(slug)) set.add(s)
    }
    return set
  }, [me, getDescendantsInclusive])

  const eligible = React.useMemo(
    () =>
      all
        .filter(
          (w) =>
            w.kind === 'org' &&
            !w.virtual &&
            eligibleSlugs.has(w.slug),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [all, eligibleSlugs],
  )

  // eligible 워크스페이스만 가지고 트리(부모-자식) 서브셋을 만든다. 사용자
  // 권한 밖의 중간 노드는 표시하지 않으므로, 본인이 임원 직책으로 본부에만
  // 멤버여서 본부 자체도 eligible 에 들어가는 경우엔 본부가 root 가 되고,
  // 본부의 하위 팀들이 children 으로 매달린다. 만약 본부엔 권한이 없고
  // team1 만 권한이라면 team1 이 그대로 root 가 된다 (위쪽 본부는 안 그림).
  const treeData = React.useMemo(() => {
    const eligibleSet = new Set(eligible.map((w) => w.slug))
    const childrenOf = new Map()
    const roots = []
    for (const w of eligible) {
      if (w.parent_slug && eligibleSet.has(w.parent_slug)) {
        if (!childrenOf.has(w.parent_slug)) childrenOf.set(w.parent_slug, [])
        childrenOf.get(w.parent_slug).push(w)
      } else {
        roots.push(w)
      }
    }
    const byName = (a, b) => a.name.localeCompare(b.name)
    for (const list of childrenOf.values()) list.sort(byName)
    roots.sort(byName)
    return { roots, childrenOf }
  }, [eligible])

  // 검색어. 비어 있으면 트리 모드, 채워지면 평면 매칭 결과 모드로 전환.
  const [query, setQuery] = React.useState('')
  // 펼침 상태. dialog 가 열릴 때마다 본인 소속(직접 멤버) 워크스페이스의
  // 조상들을 전부 펼친 상태로 시드해서, 본인이 속한 라인까지 자동으로
  // 보이도록 한다. 그 외 다른 조직 트리는 닫힌 채로 시작.
  const [expanded, setExpanded] = React.useState(() => new Set())
  React.useEffect(() => {
    if (!open) return
    const next = new Set()
    for (const m of me?.memberships ?? []) {
      const slug = m.workspace_slug
      if (!slug || slug.startsWith('personal-')) continue
      // 본인 직접 멤버 슬러그도, 그 위 조상들도 다 펼친다. eligible 트리에서
      // 보이는 조상까지만 의미가 있지만, expand set 에 더 들어가 있어도
      // 렌더에 영향이 없으니 그냥 다 넣는다.
      next.add(slug)
      for (const a of getAncestors(slug)) next.add(a.slug)
    }
    setExpanded(next)
    setQuery('')
  }, [open, me, getAncestors])

  const mountedSlugs = React.useMemo(
    () => new Set(mounts.map((m) => m.workspace_slug)),
    [mounts],
  )

  const trimmedQuery = query.trim().toLowerCase()
  const searching = trimmedQuery.length > 0
  const searchResults = React.useMemo(() => {
    if (!searching) return []
    // 매칭 위치별 우선순위 — 같은 이름이 부모/자식 양쪽에 매칭될 때
    // (예: "CAE그룹" 검색 → CAE그룹 본체 + 그 하위 파트들 모두 path 매칭)
    // 사용자가 진짜 찾는 본체가 위로 올라오도록 점수 매겨 정렬.
    //   0: 이름 완전 일치
    //   1: 이름 prefix
    //   2: 이름 substring
    //   3: slug 완전 일치
    //   4: slug prefix
    //   5: slug substring
    //   6: 경로(상위 조직명) substring 만 매칭
    // 동점은 알파벳 순.
    const scored = []
    for (const w of eligible) {
      const name = w.name.toLowerCase()
      const slug = w.slug.toLowerCase()
      const pathName = getPath(w.slug)
        .map((p) => p.name)
        .join(' / ')
        .toLowerCase()
      let score
      if (name === trimmedQuery) score = 0
      else if (name.startsWith(trimmedQuery)) score = 1
      else if (name.includes(trimmedQuery)) score = 2
      else if (slug === trimmedQuery) score = 3
      else if (slug.startsWith(trimmedQuery)) score = 4
      else if (slug.includes(trimmedQuery)) score = 5
      else if (pathName.includes(trimmedQuery)) score = 6
      else continue
      scored.push({ w, score })
    }
    scored.sort(
      (a, b) => a.score - b.score || a.w.name.localeCompare(b.w.name),
    )
    return scored.map((s) => s.w)
  }, [eligible, searching, trimmedQuery, getPath])

  function toggleExpand(slug) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }

  React.useEffect(() => {
    if (!open || !report?.id) return
    let cancelled = false
    setLoading(true)
    setError(null)
    listMounts(report.id)
      .then((rows) => {
        if (!cancelled) setMounts(rows)
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, report?.id])

  async function handlePolicyChange(workspaceSlug, nextPolicy) {
    // Optimistic local update; revert on failure.
    const prev = mounts
    setMounts((arr) =>
      arr.map((m) =>
        m.workspace_slug === workspaceSlug
          ? { ...m, edit_policy: nextPolicy }
          : m,
      ),
    )
    try {
      await setMountEditPolicy({
        reportId: report.id,
        workspaceSlug,
        editPolicy: nextPolicy,
      })
      toast.success(
        `편집 정책: ${POLICY_BY_VALUE[nextPolicy]?.label ?? nextPolicy}`,
      )
      onChanged?.()
    } catch (e) {
      setMounts(prev)
      toast.error(
        e?.response?.data?.message || '편집 정책 변경 실패',
      )
    }
  }

  async function handleToggle(workspaceSlug) {
    if (pending[workspaceSlug]) return
    const isMounted = mountedSlugs.has(workspaceSlug)
    setPending((p) => ({ ...p, [workspaceSlug]: isMounted ? 'unmounting' : 'mounting' }))
    try {
      const ws = eligible.find((w) => w.slug === workspaceSlug)
      const wsLabel = ws?.name || workspaceSlug
      if (isMounted) {
        await unmountReport({ reportId: report.id, workspaceSlug })
        setMounts((prev) => prev.filter((m) => m.workspace_slug !== workspaceSlug))
        toast.success(`${wsLabel} 게시판에서 해제`)
      } else {
        // New mounts always start with the `default` policy. To use a
        // different policy, the user changes it via the per-row
        // dropdown after the board appears as 게시됨. Keeps the dialog
        // to one knob (per-board), not two.
        const created = await mountReport({
          reportId: report.id,
          workspaceSlugs: [workspaceSlug],
          note: note.trim() || undefined,
        })
        setMounts((prev) => [...prev, ...created])
        toast.success(`${wsLabel} 게시판에 게시`)
      }
      onChanged?.()
    } catch (e) {
      const msg = e?.response?.data?.message || e?.message || '게시 작업 실패'
      toast.error(msg)
    } finally {
      setPending((p) => {
        const next = { ...p }
        delete next[workspaceSlug]
        return next
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-auto max-w-[min(48rem,92vw)]">
        <DialogHeader>
          <DialogTitle>조직 게시판에 게시</DialogTitle>
          <DialogDescription>
            보고서를 조직 게시판에 연결하면 멤버가 열람·코멘트할 수 있습니다.
            원본은 내 공간에 그대로 남고, 수정 시 게시판에도 즉시 반영됩니다.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> 게시 현황 조회 중...
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 rounded border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        ) : eligible.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4">
            게시할 수 있는 조직 게시판이 없습니다. 워크스페이스에 멤버로
            등록되어 있어야 게시 가능합니다.
          </div>
        ) : (
          <div className="space-y-3">
            {/* 검색 입력 — 워크스페이스명 / slug / 경로 어느 쪽이든 매칭.
                비어 있을 때는 트리 모드, 채워지면 평면 결과(경로 포함). */}
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="조직명 / 경로 검색 (비우면 트리 보기)"
                className="pl-7 h-8 text-sm"
              />
            </div>
            <div className="max-h-80 overflow-y-auto -mx-2 px-2 space-y-1">
              {searching ? (
                searchResults.length === 0 ? (
                  <div className="text-xs text-muted-foreground py-4 text-center">
                    매칭되는 조직이 없습니다.
                  </div>
                ) : (
                  searchResults.map((ws) => (
                    <BoardRow
                      key={ws.slug}
                      ws={ws}
                      depth={0}
                      hasChildren={false}
                      isExpanded={false}
                      onToggleExpand={null}
                      pathLabel={getPath(ws.slug)
                        .map((p) => p.name)
                        .slice(0, -1)
                        .join(' / ')}
                      mounts={mounts}
                      mountedSlugs={mountedSlugs}
                      pending={pending}
                      isOwner={isOwner}
                      report={report}
                      setMounts={setMounts}
                      onChanged={onChanged}
                      onToggle={handleToggle}
                      onPolicyChange={handlePolicyChange}
                    />
                  ))
                )
              ) : (
                <TreeNodes
                  nodes={treeData.roots}
                  depth={0}
                  childrenOf={treeData.childrenOf}
                  expanded={expanded}
                  onToggleExpand={toggleExpand}
                  mounts={mounts}
                  mountedSlugs={mountedSlugs}
                  pending={pending}
                  isOwner={isOwner}
                  report={report}
                  setMounts={setMounts}
                  onChanged={onChanged}
                  onToggle={handleToggle}
                  onPolicyChange={handlePolicyChange}
                />
              )}
            </div>

            <div className="border-t pt-3">
              <label className="text-xs text-muted-foreground block mb-1">
                게시 메모 (선택, 새 게시에만 적용)
              </label>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="예: 본부 보고 자료로 활용 부탁드립니다."
                rows={2}
                className="resize-none text-sm"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Tree 모드 렌더 — root 들을 재귀적으로 펼친다. 펼침 상태에 따라 자식이
 *  보이거나 접힌다. 검색 모드일 땐 이 컴포넌트를 거치지 않고 평면 결과를
 *  BoardRow 로 직접 매핑한다. */
function TreeNodes({
  nodes,
  depth,
  childrenOf,
  expanded,
  onToggleExpand,
  ...rowProps
}) {
  return nodes.map((ws) => {
    const kids = childrenOf.get(ws.slug) ?? []
    const hasChildren = kids.length > 0
    const isExpanded = expanded.has(ws.slug)
    return (
      <React.Fragment key={ws.slug}>
        <BoardRow
          ws={ws}
          depth={depth}
          hasChildren={hasChildren}
          isExpanded={isExpanded}
          onToggleExpand={hasChildren ? () => onToggleExpand(ws.slug) : null}
          pathLabel=""
          {...rowProps}
        />
        {hasChildren && isExpanded && (
          <TreeNodes
            nodes={kids}
            depth={depth + 1}
            childrenOf={childrenOf}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            {...rowProps}
          />
        )}
      </React.Fragment>
    )
  })
}

/** 단일 게시판 행 — 트리 모드에서도, 검색 모드에서도 같은 컴포넌트를
 *  쓴다. 차이점은:
 *    - 트리 모드: depth 기반 들여쓰기 + chevron (있을 때 펼침 토글)
 *    - 검색 모드: depth=0, chevron 자리에 비어 있는 spacer, 본문 아래
 *      breadcrumb 경로 (조상 워크스페이스 이름 / / / ...). */
function BoardRow({
  ws,
  depth,
  hasChildren,
  isExpanded,
  onToggleExpand,
  pathLabel,
  mounts,
  mountedSlugs,
  pending,
  isOwner,
  report,
  setMounts,
  onChanged,
  onToggle,
  onPolicyChange,
}) {
  const isMounted = mountedSlugs.has(ws.slug)
  const isPending = Boolean(pending[ws.slug])
  const mount = mounts.find((m) => m.workspace_slug === ws.slug)
  // depth 0 도 8px 정도 안쪽에서 시작 — 너무 벽에 붙으면 chevron 영역과
  // 콘텐츠가 시각적으로 구분이 안 된다.
  const indentPx = depth * 16
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
        isMounted ? 'border-primary/40 bg-primary/5' : 'border-border',
        isPending && 'opacity-60',
      )}
      style={{ marginLeft: indentPx }}
    >
      {/* Chevron — 트리 모드에서 자식 있는 노드만 활성. 자식 없는 노드는
          같은 너비의 빈 spacer 로 둬서 행 간 정렬이 일관되게 유지된다. */}
      {onToggleExpand ? (
        <button
          type="button"
          onClick={onToggleExpand}
          className="h-5 w-5 shrink-0 flex items-center justify-center rounded hover:bg-muted/50"
          aria-label={isExpanded ? '접기' : '펼치기'}
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
      ) : (
        <span className="h-5 w-5 shrink-0" aria-hidden />
      )}
      {/* Workspace toggle (click row body to mount/unmount) */}
      <button
        type="button"
        disabled={isPending}
        onClick={() => onToggle(ws.slug)}
        className="flex items-center gap-2 flex-1 min-w-0 text-left hover:bg-muted/30 rounded -ml-1 px-1 py-0.5"
        title={isMounted ? '게시 해제' : '게시'}
      >
        <span
          className="h-2.5 w-2.5 rounded-full shrink-0"
          style={{ backgroundColor: ws.color }}
        />
        <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 min-w-0">
          <span className="block truncate">{ws.name}</span>
          {pathLabel && (
            <span className="block text-[10px] text-muted-foreground truncate">
              {pathLabel}
            </span>
          )}
        </span>
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
        ) : isMounted ? (
          <span className="flex items-center gap-1 text-xs text-primary shrink-0">
            <Check className="h-3.5 w-3.5" />
            게시됨
          </span>
        ) : (
          <span className="text-xs text-muted-foreground shrink-0">게시</span>
        )}
      </button>
      {/* Folder picker — mounted 보드만 노출. */}
      {isMounted && (
        <FolderPickerButton
          mode="org"
          workspaceSlug={ws.slug}
          reportId={report.id}
          folderId={mount?.folder_id ?? null}
          onChanged={(newFolderId) => {
            setMounts((prev) =>
              prev.map((m) =>
                m.workspace_slug === ws.slug
                  ? { ...m, folder_id: newFolderId }
                  : m,
              ),
            )
            onChanged?.()
          }}
        />
      )}
      {/* Per-mount edit-policy — owner 만 노출. */}
      {isMounted && isOwner && (
        <select
          value={mount?.edit_policy ?? 'default'}
          onChange={(e) => onPolicyChange(ws.slug, e.target.value)}
          className="text-[11px] rounded border bg-background px-1.5 py-1 hover:border-primary/60 cursor-pointer"
          title={POLICY_BY_VALUE[mount?.edit_policy ?? 'default']?.description}
        >
          {POLICY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
