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
  ChevronsUpDown,
  ChevronsDownUp,
  Search,
  X,
  MessageSquare,
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
  listGrantBoardSlugs,
  mountReport,
  unmountReport,
  setMountFolder,
  setMountEditPolicy,
  setMountNote,
} from '@/shared/api/mounts'
import { requestTakedown } from '@/shared/api/takedowns'
import { FolderPickerButton } from './FolderPickerButton'
import { cn } from '@/shared/lib/utils'

/** Edit policy options for the per-mount dropdown. The short labels go
 *  on the chip; the descriptions appear in the dropdown row + tooltip
 *  so users learn the semantics without a separate help page. */
// 게시 시 편집 권한(공유 grant 에 연결). 열람 전용 = 작성자만 편집,
// 공동 편집 = 그 게시판 멤버 누구나 편집(부서 편집 grant). 옛 owner_only 는
// 열람 전용과 동일 취급(작성자만), default 도 보직장 자동편집 폐기로 열람 전용.
const POLICY_OPTIONS = [
  {
    value: 'default',
    label: '열람 전용',
    description: '작성자만 편집',
  },
  {
    value: 'manager',
    label: '작성자+매니저',
    description: '작성자와 게시판 매니저만 편집',
  },
  {
    value: 'coauthor',
    label: '공동 편집',
    description: '게시판 멤버 누구나 편집',
  },
]
const POLICY_BY_VALUE = Object.fromEntries(
  POLICY_OPTIONS.map((o) => [o.value, o]),
)
// 표시용 정규화 — coauthor=공동, manager=작성자+매니저, 나머지(default/
// owner_only)=열람 전용.
const normPolicy = (p) =>
  p === 'coauthor' ? 'coauthor' : p === 'manager' ? 'manager' : 'default'

export function MountDialog({ open, onOpenChange, report, onChanged }) {
  const { all, getDescendantsInclusive, getAncestors, getPath } = useWorkspace()
  const { me } = useAuth()

  const [mounts, setMounts] = React.useState([])
  // 멤버는 아니지만 편집 권한이 열려 있어 게시할 수 있는 게시판 slug 들
  // (board edit grant). 멤버십 기반 후보에 union 한다.
  const [grantSlugs, setGrantSlugs] = React.useState([])
  const [pending, setPending] = React.useState({}) // slug → 'mounting' | 'unmounting'
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(null)
  // 방금 게시한 게시판 slug — 그 행의 메모 입력을 자동으로 열어 안내한다.
  const [justMountedSlug, setJustMountedSlug] = React.useState(null)
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
    // 멤버십 밖이라도 편집 권한이 개방된 게시판은 게시 후보에 포함.
    for (const slug of grantSlugs) set.add(slug)
    return set
  }, [me, getDescendantsInclusive, grantSlugs])

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

  // 이미 게시된 보드가 있으면 그 보드 + 조상 라인까지 펼쳐, 다이얼로그가
  // 열릴 때 "선택된 조직"이 트리에서 바로 보이도록 한다. mounts 는 open 후
  // 비동기로 로드되므로 위 시드 effect 와 분리해, 도착 시점에 additive 로
  // 합친다(prev 기반 union 이라 시드 펼침을 덮어쓰지 않음). 이 effect 가
  // 시드 effect *뒤*에 정의돼 있어, open 시 시드(replace) → 마운트(union)
  // 순서가 보장된다.
  React.useEffect(() => {
    if (!open || mounts.length === 0) return
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const m of mounts) {
        const slug = m.workspace_slug
        if (!slug) continue
        next.add(slug)
        for (const a of getAncestors(slug)) next.add(a.slug)
      }
      return next
    })
  }, [open, mounts, getAncestors])

  const mountedSlugs = React.useMemo(
    () => new Set(mounts.map((m) => m.workspace_slug)),
    [mounts],
  )

  // 게시 현황 — 지금 이 보고서가 올라가 있는 게시판만 평면 리스트로. mount
  // 행에는 이름/색상이 없으므로 getPath 로 해석한다. 더 이상 멤버가 아닌
  // 게시판(getPath 가 빈 배열)이라도 slug 로 표시하고 해제는 가능하게 둔다.
  const mountedBoards = React.useMemo(() => {
    return mounts
      .map((m) => {
        const path = getPath(m.workspace_slug)
        const ws = path.length ? path[path.length - 1] : null
        const pathLabel = path
          .slice(0, -1)
          .map((p) => p.name)
          .join(' / ')
        return { mount: m, ws, slug: m.workspace_slug, pathLabel }
      })
      .sort((a, b) =>
        (a.ws?.name || a.slug).localeCompare(b.ws?.name || b.slug),
      )
  }, [mounts, getPath])

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

  // '모두 펼치기/접기' 토글 — 자식이 있는 노드(=childrenOf 키)만 펼침 대상.
  // 전부 펼쳐져 있으면 접기, 아니면 모두 펼치기로 동작.
  const expandableSlugs = React.useMemo(
    () => [...treeData.childrenOf.keys()],
    [treeData],
  )
  const allExpanded =
    expandableSlugs.length > 0 &&
    expandableSlugs.every((s) => expanded.has(s))
  function toggleExpandAll() {
    setExpanded(allExpanded ? new Set() : new Set(expandableSlugs))
  }

  React.useEffect(() => {
    if (!open || !report?.id) {
      // 닫히는 중(report → null) 이전 보드의 mount 행이 남아 있으면
      // BoardRow 가 report.id 를 읽다 터지므로 비워 둔다.
      setMounts([])
      return
    }
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

  // 편집 권한이 개방된 게시판 후보(board edit grant). 사용자 단위라 report 와
  // 무관하므로 다이얼로그가 열릴 때 한 번 불러온다. 실패해도 멤버십 기반
  // 후보는 그대로 동작하므로 조용히 무시.
  React.useEffect(() => {
    if (!open) {
      setGrantSlugs([])
      return
    }
    let cancelled = false
    listGrantBoardSlugs()
      .then((slugs) => {
        if (!cancelled) setGrantSlugs(slugs)
      })
      .catch(() => {
        if (!cancelled) setGrantSlugs([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

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
        { description: POLICY_BY_VALUE[nextPolicy]?.description },
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
        })
        setMounts((prev) => [...prev, ...created])
        // 방금 게시한 게시판 행의 메모 입력을 자동으로 열어 안내(per-board).
        setJustMountedSlug(workspaceSlug)
        // 새 게시는 기본 '열람 전용' 정책 — 선택한 방식 설명을 함께 안내.
        toast.success(`${wsLabel} 게시판에 게시`, {
          description: `${POLICY_BY_VALUE.default.label} — ${POLICY_BY_VALUE.default.description}`,
        })
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

  // "게시판에서 내리기 요청" — 작성자가 관리하지 않는 게시판은 직접 못 내리므로,
  // 게시된 board 마다 게시취소 요청을 보낸다(관리하는 board 는 즉시 내려감).
  const [requesting, setRequesting] = React.useState(false)
  async function handleRequestTakedown() {
    if (requesting) return
    setRequesting(true)
    try {
      const res = await requestTakedown(report.id)
      const requested = res?.requested ?? 0
      const autoRemoved = res?.auto_removed ?? 0
      if (requested === 0 && autoRemoved === 0) {
        toast('게시된 게시판이 없습니다.')
      } else {
        const parts = []
        if (autoRemoved) parts.push(`${autoRemoved}개 게시판에서 바로 내림`)
        if (requested) parts.push(`${requested}개 게시판에 요청 보냄 (매니저 승인 대기)`)
        toast.success(parts.join(' · '))
      }
      const rows = await listMounts(report.id)
      setMounts(rows)
      onChanged?.()
    } catch (e) {
      const msg = e?.response?.data?.message || e?.message || '요청 실패'
      toast.error(msg)
    } finally {
      setRequesting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col w-[80vw] max-w-[80vw] h-[80vh]">
        <DialogHeader>
          <DialogTitle>조직 게시판에 게시</DialogTitle>
          <DialogDescription>
            보고서를 조직 게시판에 연결하면 멤버가 열람·코멘트할 수 있습니다.
            원본은 내 공간에 그대로 남고, 수정 시 게시판에도 즉시 반영됩니다.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> 게시 현황 조회 중...
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 rounded border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex gap-4">
            {/* ─── 좌: 게시판 선택 (트리/검색) ─── 권한 내 조직 트리/검색.
                이미 게시된 게시판은 여기서도 '게시됨'으로 강조된다. */}
            <div className="flex-1 min-w-0 flex flex-col gap-2">
              {eligible.length === 0 ? (
                <div className="text-sm text-muted-foreground py-2">
                  추가로 게시할 수 있는 조직 게시판이 없습니다. 워크스페이스에
                  멤버로 등록되어 있어야 게시 가능합니다.
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium text-foreground">
                      게시판 선택
                    </div>
                    {/* 모두 펼치기/접기 — 검색 모드(평면 결과)에선 의미가 없어
                        트리 모드일 때만 노출. */}
                    {!searching && expandableSlugs.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-muted-foreground"
                        onClick={toggleExpandAll}
                      >
                        {allExpanded ? (
                          <ChevronsDownUp className="h-3.5 w-3.5 mr-1" />
                        ) : (
                          <ChevronsUpDown className="h-3.5 w-3.5 mr-1" />
                        )}
                        {allExpanded ? '모두 접기' : '모두 펼치기'}
                      </Button>
                    )}
                  </div>
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
                  <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 space-y-1">
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
                    <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                      <MessageSquare className="mt-0.5 h-3 w-3 shrink-0 opacity-70" />
                      <span>
                        게시 메모는 게시판을 게시한 뒤 오른쪽{' '}
                        <b className="text-foreground">현재 게시됨</b> 목록에서
                        게시판마다 따로 남길 수 있어요. (게시하면 메모 입력이
                        바로 열립니다.)
                      </span>
                    </p>
                  </div>
                </>
              )}
            </div>

            {/* ─── 우: 게시 현황 ─── 지금 이 보고서가 올라가 있는 게시판만
                평면 리스트로. 여기서 바로 게시 해제 / 폴더 / 편집정책 변경.
                eligible 이 비어도(멤버십 상실) 현황은 항상 보여, 작성자가 남은
                게시를 확인·해제할 수 있게 한다. */}
            <div className="w-[42%] shrink-0 flex flex-col gap-2 border-l pl-4">
              <div className="text-xs font-medium text-foreground">
                현재 게시됨
                {mountedBoards.length > 0 ? ` (${mountedBoards.length})` : ''}
              </div>
              {mountedBoards.length === 0 ? (
                <div className="text-xs text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center">
                  아직 게시된 게시판이 없습니다. 왼쪽에서 게시판을 선택해
                  게시하세요.
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 space-y-1">
                  {mountedBoards.map(({ mount, ws, slug, pathLabel }) => (
                    <MountedBoardRow
                      key={slug}
                      ws={ws}
                      slug={slug}
                      pathLabel={pathLabel}
                      mount={mount}
                      pending={pending}
                      isOwner={isOwner}
                      report={report}
                      setMounts={setMounts}
                      onChanged={onChanged}
                      onToggle={handleToggle}
                      onPolicyChange={handlePolicyChange}
                      autoEditNote={justMountedSlug === slug}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        </div>

        <DialogFooter className="sm:justify-between">
          {/* 작성자: 게시된 모든 부서 게시판에서 내리기 요청. 관리하는 board 는
              즉시 내려가고, 나머지는 그 board 매니저의 승인을 기다린다. */}
          {isOwner && mountedBoards.length > 0 ? (
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive"
              disabled={requesting}
              onClick={handleRequestTakedown}
              title="게시된 부서 게시판에서 내리기 요청 (매니저 승인)"
            >
              게시판에서 내리기 요청
            </Button>
          ) : (
            <span />
          )}
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
  isExpanded,
  onToggleExpand,
  pathLabel,
  mountedSlugs,
  pending,
  onToggle,
}) {
  const isMounted = mountedSlugs.has(ws.slug)
  const isPending = Boolean(pending[ws.slug])
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
      {/* 폴더·편집정책 컨트롤은 좌측 트리에는 두지 않는다. 게시 여부 토글만
          담당하고, 폴더/정책 조정은 우측 '현재 게시됨' 패널(MountedBoardRow)
          에서만 한다 — 선택과 관리 화면을 분리해 트리를 단순하게 유지. */}
    </div>
  )
}

/** 게시 현황 행 — '현재 게시됨' 섹션 전용. BoardRow 와 달리 트리/펼침이 없고,
 *  본문 클릭이 아니라 명시적인 "해제" 버튼으로 게시를 취소한다(현황 화면에서
 *  실수로 본문을 눌러 해제되는 일을 막기 위함). 폴더·편집정책 변경은 BoardRow
 *  와 동일. ws 가 null 이면(더 이상 멤버가 아닌 게시판) slug 로 표시하되 해제는
 *  가능하게 둔다. 게시/해제·정책·폴더 핸들러는 BoardRow 와 같은 것을 재사용. */
function MountedBoardRow({
  ws,
  slug,
  pathLabel,
  mount,
  pending,
  isOwner,
  report,
  setMounts,
  onChanged,
  onToggle,
  onPolicyChange,
  autoEditNote = false,
}) {
  const isPending = Boolean(pending[slug])
  const note = mount?.note ?? ''
  // 방금 게시한 게시판이면 메모 입력을 자동으로 펼쳐 사용자를 안내.
  const [editingNote, setEditingNote] = React.useState(Boolean(autoEditNote))
  const [noteDraft, setNoteDraft] = React.useState(note)
  const [savingNote, setSavingNote] = React.useState(false)
  // mount.note 가 외부에서 바뀌면(다른 행 저장 등) 편집 중이 아닐 때만 동기화.
  React.useEffect(() => {
    if (!editingNote) setNoteDraft(note)
  }, [note, editingNote])

  async function saveNote() {
    if (!report) return
    setSavingNote(true)
    try {
      const data = await setMountNote({
        reportId: report.id,
        workspaceSlug: slug,
        note: noteDraft,
      })
      const saved = data?.note ?? noteDraft.trim()
      setMounts((prev) =>
        prev.map((m) =>
          m.workspace_slug === slug ? { ...m, note: saved } : m,
        ),
      )
      setEditingNote(false)
      onChanged?.()
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err.message || '메모 저장 실패',
      )
    } finally {
      setSavingNote(false)
    }
  }

  return (
    <div
      className={cn(
        'rounded-md border border-primary/40 bg-primary/5 transition-colors',
        isPending && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
      <span
        className="h-2.5 w-2.5 rounded-full shrink-0"
        style={{ backgroundColor: ws?.color || '#cbd5e1' }}
      />
      <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="flex-1 min-w-0">
        <span className="block truncate">{ws?.name || slug}</span>
        {pathLabel && (
          <span className="block text-[10px] text-muted-foreground truncate">
            {pathLabel}
          </span>
        )}
      </span>
      {/* 게시 메모 — 클릭하면 아래에 표시/편집. 메모 있으면 점 표시. */}
      {report && (
        <button
          type="button"
          onClick={() => setEditingNote((v) => !v)}
          className={cn(
            'relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-primary/10',
            note ? 'text-primary' : 'text-muted-foreground',
          )}
          title={note ? `게시 메모: ${note}` : '게시 메모 추가'}
        >
          <MessageSquare className="h-3.5 w-3.5" />
          {note && (
            <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />
          )}
        </button>
      )}
      {/* 폴더 — report 가 null 인 stale 렌더 가드 (BoardRow 와 동일). */}
      {report && (
        <FolderPickerButton
          mode="org"
          workspaceSlug={slug}
          reportId={report.id}
          folderId={mount?.folder_id ?? null}
          onChanged={(newFolderId) => {
            setMounts((prev) =>
              prev.map((m) =>
                m.workspace_slug === slug
                  ? { ...m, folder_id: newFolderId }
                  : m,
              ),
            )
            onChanged?.()
          }}
        />
      )}
      {/* Per-mount edit-policy — owner 만 노출. */}
      {isOwner && (
        <select
          value={normPolicy(mount?.edit_policy)}
          onChange={(e) => onPolicyChange(slug, e.target.value)}
          className="text-[11px] rounded border bg-background px-1.5 py-1 hover:border-primary/60 cursor-pointer"
          title={POLICY_BY_VALUE[normPolicy(mount?.edit_policy)]?.description}
        >
          {POLICY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {/* 게시 해제 — 이 게시판을 *관리하는* 사람만(매니저/시스템관리자). 작성자라도
          관리 안 하는 board 는 해제 버튼 대신, 푸터의 "게시판에서 내리기 요청"으로
          매니저 승인을 받는다(can_unmount 로 게이팅). */}
      {mount?.can_unmount ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => onToggle(slug)}
          className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
          title="이 게시판에서 게시 해제"
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <>
              <X className="h-3.5 w-3.5 mr-0.5" />
              해제
            </>
          )}
        </Button>
      ) : (
        <span
          className="h-7 px-2 text-[11px] text-muted-foreground shrink-0 inline-flex items-center"
          title="이 게시판은 매니저만 게시취소할 수 있습니다. 아래 '게시판에서 내리기 요청'을 보내세요."
        >
          요청 필요
        </span>
      )}
      </div>
      {/* 게시 메모 표시/편집 영역 — 메모가 있거나 편집 중일 때만. */}
      {report && (editingNote || note) && (
        <div className="px-3 pb-2">
          {editingNote ? (
            <div className="space-y-1.5">
              <Textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="이 게시판에 남길 메모 (예: 본부 보고 자료로 활용 부탁드립니다.)"
                rows={2}
                maxLength={1000}
                className="resize-none text-xs"
                autoFocus
              />
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={saveNote}
                  disabled={savingNote}
                >
                  {savingNote ? '저장 중...' : '저장'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => {
                    setEditingNote(false)
                    setNoteDraft(note)
                  }}
                >
                  취소
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditingNote(true)}
              className="flex w-full items-start gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
              title="클릭해서 메모 수정"
            >
              <MessageSquare className="mt-0.5 h-3 w-3 shrink-0 opacity-70" />
              <span className="whitespace-pre-wrap break-words">{note}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
