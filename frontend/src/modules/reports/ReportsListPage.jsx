import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Filter,
  Folder as FolderIcon,
  FolderInput,
  Inbox,
  Link2,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
  ShieldQuestion,
  Trash2,
  Unlink,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Input } from '@/shared/components/ui/input'
import { Textarea } from '@/shared/components/ui/textarea'
import { Label } from '@/shared/components/ui/label'
import { DataTable } from '@/shared/components/DataTable'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { WorkspaceCombobox } from '@/shared/components/WorkspaceCombobox'
import { useAuth } from '@/shared/auth/AuthContext'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { deleteReport, listReports, moveReportToFolder } from './api'
import { setMountFolder } from '@/shared/api/mounts'

/** MIME type carried by a report-row drag. FolderSidebar checks for this
 *  string to distinguish "user is dragging reports into me" from "user is
 *  dragging a folder under me" (the existing folder-tree D&D). Module-
 *  level constant so the source and the destination can't drift. */
const REPORT_DRAG_MIME = 'application/x-report-ids'
export { REPORT_DRAG_MIME }
import { mountReport, unmountReport } from '@/shared/api/mounts'
import { listTemplates } from '@/shared/api/templates'
import { listEntityTypes } from '@/shared/api/entities'
import { listFolders } from '@/shared/api/folders'
import { EntityMultiPicker } from '@/modules/entities/EntityMultiPicker'
import { PHASES, PHASE_LABEL, PHASE_VARIANT } from './constants'
import {
  FolderSidebar,
  FOLDER_FILTER_ALL,
  FOLDER_FILTER_UNCATEGORIZED,
} from './FolderSidebar'
import { MountDialog } from './MountDialog'
import { cn } from '@/shared/lib/utils'

export default function ReportsListPage() {
  const { slug, workspace, all: workspaces, getAncestors, getDescendantsInclusive } = useWorkspace()
  const { me } = useAuth()
  const navigate = useNavigate()
  const [onlyMine, setOnlyMine] = useState(false)
  // Slug to scope by — empty means "no filter". The picked workspace's
  // descendants_inclusive becomes the visible set, so admins at any tier
  // can dive into any sub-team they cover.
  const [scopeSlug, setScopeSlug] = useState('')
  // Entity tag filter — flat list of slim EntityRefMini so chips render
  // labels without a second lookup. Server gets just the ids. Resets on
  // workspace switch (the useAsync below is keyed by slug, but this
  // state lives on the component, so we wipe it via the effect).
  const [entityFilter, setEntityFilter] = useState([])
  // Folder filter — `null` = 전체, 'uncategorized' = no folder, number
  // = specific folder id. Resets on workspace switch. Applies in both
  // personal AND org workspaces (Phase 1.6 brought folders to org).
  const [folderFilter, setFolderFilter] = useState(FOLDER_FILTER_ALL)
  // Phase filter — '' = 전체, otherwise a ReportPhase value. Cheap
  // client-side filter (every row already carries `phase`); the picker
  // is a small native select inside FilterBar to keep the toolbar tidy.
  const [phaseFilter, setPhaseFilter] = useState('')
  // 기간 필터 (보고서 활동 = updated_at). '' = 전체, 'd30'/'d90'/'d365'
  // = 최근 N일, 'y2026' = 2026년에 활동한 보고서만. 10년 누적 환경에서
  // default "전체" 가 부담스러우면 사용자가 좁힘. 클라이언트 사이드 —
  // 페이지 크기보다 데이터셋이 크면 백엔드 필터로 옮길 자리.
  const [periodFilter, setPeriodFilter] = useState('')
  // 게시판 필터 — '' = 전체, otherwise 워크스페이스 slug. 그 보고서가
  // 해당 워크스페이스에 mount 되어 있는지로 필터. 사용자의 mount 가
  // 실제 있는 워크스페이스만 옵션으로 노출 (빈 옵션 안 생김).
  const [mountWorkspaceFilter, setMountWorkspaceFilter] = useState('')
  const isPersonal = workspace?.kind === 'personal'
  const isOrg = workspace?.kind === 'org'
  const showFolderSidebar = isPersonal || isOrg
  // 시스템 관리자가 '가입자 공간' 으로 다른 가입자의 personal 워크스페이스
  // 에 진입한 경우. 폴더 API 는 backend 가 personal-{N} 슬러그를 받아
  // 그 가입자의 폴더로 분기 — sys admin 만 통과한다.
  const isViewingOtherPersonal =
    isPersonal && workspace?.personal_owner_user_id !== me?.user?.id
  // Permission gate for folder CRUD: personal always allowed for owner;
  // org limited to workspace manager. me.role reflects the current
  // workspace's role for the actor (resolved server-side per request).
  const canEditFolders = isPersonal
    ? true
    : isOrg && me?.role === 'manager'

  useEffect(() => {
    setEntityFilter([])
    setFolderFilter(FOLDER_FILTER_ALL)
    setPhaseFilter('')
    setPeriodFilter('')
    setMountWorkspaceFilter('')
  }, [slug])
  // Bulk-select state — a Set of report ids the user has ticked. We
  // clear on any context shift (workspace / folder / tag filter) so a
  // stale id from a previous view doesn't survive into a delete/move
  // that the user can no longer see in the table.
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [bulkUnmountOpen, setBulkUnmountOpen] = useState(false)
  const [bulkMountOpen, setBulkMountOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  // FolderSidebar 의 폴더별 카운트(report_count, uncategorized_count) 는
  // 자체 listFolders 응답에서 오기 때문에, 여기서 보고서를 옮기거나
  // 삭제해도 reload() 만으론 갱신이 안 된다. 이 키를 bump 하면 사이드바
  // 가 refresh 한다 — 폴더 CRUD 와 동일한 effect 트리거.
  const [folderReloadKey, setFolderReloadKey] = useState(0)
  const bumpFolderReload = useCallback(
    () => setFolderReloadKey((k) => k + 1),
    [],
  )
  // MountDialog opened from the 게시 cell click — `null` = closed.
  // We pass the full report row so the dialog has report.owner_user_id /
  // title without a second fetch. onChanged triggers reload() so the
  // updated mount_workspaces flow back into the table immediately.
  const [mountDialogReport, setMountDialogReport] = useState(null)
  const entityFilterIds = useMemo(
    () => entityFilter.map((e) => e.id),
    [entityFilter],
  )
  // `entityFilterKey` is a stable string so the useAsync dep array
  // doesn't re-fire on every render — arrays of ids would be a new
  // reference each pass even when the contents match.
  const entityFilterKey = entityFilterIds.join(',')
  // Encode folder filter into a stable string for the dep array. null
  // is "no filter" — don't send `folder_id` at all in that case.
  const folderQueryValue =
    folderFilter === FOLDER_FILTER_ALL || !showFolderSidebar
      ? undefined
      : folderFilter
  const { data: reports, loading, error, reload } = useAsync(
    () =>
      slug
        ? listReports({
            entityIds: entityFilterIds,
            folderId: folderQueryValue,
          })
        : Promise.resolve([]),
    [slug, entityFilterKey, folderQueryValue]
  )
  const { data: templates } = useAsync(
    () => (slug ? listTemplates() : Promise.resolve([])),
    [slug]
  )
  const templateName = makeTemplateNameLookup(templates)

  const myUserId = me?.user?.id
  const myHomeSlug = me?.memberships?.[0]?.workspace_slug

  // Workspaces eligible as a "내 소속" scope target — the user's home,
  // every descendant under it (for parent-tier members that want to drill
  // into a specific sub-team), and every ancestor (for leaf-tier members
  // that want to widen out). Virtual workspaces are excluded.
  const scopeChoices = useMemo(() => {
    if (!myHomeSlug || !workspaces) return []
    const slugMap = new Map(workspaces.map((w) => [w.slug, w]))
    const eligible = new Set()
    for (const s of getDescendantsInclusive(myHomeSlug)) eligible.add(s)
    for (const a of getAncestors(myHomeSlug)) eligible.add(a.slug)
    return [...eligible]
      .map((s) => slugMap.get(s))
      .filter((w) => w && !w.virtual)
  }, [myHomeSlug, workspaces, getDescendantsInclusive, getAncestors])

  // Resolve the picked scope into the actual filterable slug set
  // (descendants_inclusive of the picked workspace). Empty = no filter.
  const scopedSet = useMemo(() => {
    if (!scopeSlug) return null
    return new Set(getDescendantsInclusive(scopeSlug))
  }, [scopeSlug, getDescendantsInclusive])

  // Clear selection whenever the underlying data context changes —
  // workspace switch, folder switch, or entity-tag filter change.
  // Search/sort don't fire this because the row set is still the same
  // collection, just re-ordered.
  useEffect(() => {
    setSelectedIds(new Set())
  }, [slug, folderQueryValue, entityFilterKey])

  // 기간 필터의 lower-bound 를 ISO 문자열로 한 번 계산. 'd30'/'d90'/
  // 'd365' → now - N일, 'y2026' → 2026-01-01. Compare 가 ISO 문자열로
  // 곧장 가능해서 Date 객체 생성 없이 startsWith / >= 비교만.
  const { rangeStart, rangeEnd } = useMemo(() => {
    if (!periodFilter) return { rangeStart: null, rangeEnd: null }
    if (periodFilter.startsWith('y')) {
      const year = periodFilter.slice(1)
      return { rangeStart: `${year}-01-01`, rangeEnd: `${Number(year) + 1}-01-01` }
    }
    const days = { d30: 30, d90: 90, d365: 365 }[periodFilter]
    if (!days) return { rangeStart: null, rangeEnd: null }
    const ms = Date.now() - days * 24 * 60 * 60 * 1000
    return { rangeStart: new Date(ms).toISOString(), rangeEnd: null }
  }, [periodFilter])

  // Apply `onlyMine` / `scopedSet` / `phaseFilter` / `periodFilter` /
  // `mountWorkspaceFilter` here so the visible total and table contents
  // stay consistent.
  const list = (reports ?? [])
    .filter((r) => !onlyMine || r.owner_user_id === myUserId)
    .filter((r) => !scopedSet || scopedSet.has(r.workspace_slug))
    .filter((r) => !phaseFilter || r.phase === phaseFilter)
    .filter((r) => {
      if (!rangeStart) return true
      const t = r.updated_at
      if (!t) return false
      if (t < rangeStart) return false
      if (rangeEnd && t >= rangeEnd) return false
      return true
    })
    .filter((r) => {
      if (!mountWorkspaceFilter) return true
      return (r.mount_workspaces ?? []).some(
        (m) => m.slug === mountWorkspaceFilter,
      )
    })
    .map((r) => ({
      ...r,
      // Flatten the embedded report_type ref into a sortable/searchable
      // string so DataTable's column sort + substring search both work
      // without bespoke comparators. `report_type` itself is kept around
      // for the cell renderer's badge.
      report_type_name: r.report_type?.name ?? '',
      // Flatten mount targets so the search bar can hit by board name
      // ("팀1") — DataTable only inspects each row's own keys.
      mount_names: (r.mount_workspaces ?? []).map((m) => m.name).join(' '),
    }))

  // 게시판 필터 옵션 — 실제로 mount 가 존재하는 워크스페이스만. union
  // of every report's mount_workspaces, deduped + sorted by name. 깨끗한
  // 옵션 리스트라 "팀1 (0건)" 같은 무의미 옵션이 안 생김.
  const mountWorkspaceOptions = useMemo(() => {
    const seen = new Map()
    for (const r of reports ?? []) {
      for (const m of r.mount_workspaces ?? []) {
        if (!seen.has(m.slug)) seen.set(m.slug, m.name)
      }
    }
    return [...seen.entries()]
      .map(([slug, name]) => ({ slug, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [reports])

  // 기간 필터의 "특정 연도" 옵션 — 데이터에 실제로 존재하는 updated_at
  // 의 distinct year. 10년 지나도 자동으로 옵션이 늘어남.
  const periodYearOptions = useMemo(() => {
    const years = new Set()
    for (const r of reports ?? []) {
      const y = r.updated_at?.slice(0, 4)
      if (y) years.add(y)
    }
    return [...years].sort().reverse()
  }, [reports])

  // Column widths are pinned so page navigation doesn't reflow them.
  // 제목 stays flexible (no explicit width) so it absorbs whatever
  // space the fixed-width columns don't take. The "max content" of
  // 상태 / 작성자 / 부서 / 날짜 columns is short, so keeping them
  // tight here makes the title cell read longer.
  const columns = [
    {
      // Report's DB id — stable, matches the URL the row navigates to,
      // and survives sort/filter changes (unlike a derived "row index"
      // would). Sortable so users can quickly find a report they
      // remember by number.
      key: 'id',
      header: '번호',
      sortable: true,
      headerClassName: 'w-[64px] text-right',
      cellClassName: 'text-right',
      render: (r) => (
        <span className="text-xs text-muted-foreground tabular-nums">
          {r.id}
        </span>
      ),
    },
    {
      key: 'title',
      header: '제목',
      sortable: true,
      // min-w-[260px] keeps the title legible even when the sidebar
      // narrows the available width. Past that point the table itself
      // scrolls horizontally (DataTable's container has overflow-x-auto)
      // instead of squishing the title down to a few characters.
      headerClassName: 'min-w-[260px]',
      cellClassName: 'font-medium truncate min-w-[260px]',
      render: (r) => (
        <span className="block truncate" title={r.title}>
          {r.title}
        </span>
      ),
    },
    {
      key: 'template_id',
      header: '템플릿',
      sortable: true,
      headerClassName: 'w-[180px]',
      cellClassName: 'truncate',
      render: (r) => {
        // Multi-page reports may bind a different template per page. Show
        // every distinct (template_id, version) pair so the list reflects
        // the actual makeup. Falls back to the top-level binding when the
        // pages array is empty (legacy single-page rows).
        const pairs = uniqueTemplatePairs(r)
        const labels = pairs.map(
          ([id, ver]) => `${templateName(id)} v${ver}`,
        )
        const fullText = labels.join(', ')
        return (
          <span
            className="block truncate text-xs text-muted-foreground"
            title={fullText}
          >
            {fullText}
          </span>
        )
      },
    },
    {
      key: 'report_type_name',
      header: '종류',
      sortable: true,
      headerClassName: 'w-[140px]',
      cellClassName: 'truncate',
      render: (r) => {
        const t = r.report_type
        if (!t) return <span className="text-xs text-muted-foreground/60">—</span>
        const isUnofficial = t.status === 'unofficial'
        return (
          <span
            className="inline-flex items-center gap-1 text-xs"
            title={t.description || t.name}
          >
            {isUnofficial ? (
              <ShieldQuestion
                className="h-3 w-3 text-muted-foreground shrink-0"
                aria-label="비공식"
              />
            ) : (
              <ShieldCheck
                className="h-3 w-3 text-emerald-600 shrink-0"
                aria-label="공식"
              />
            )}
            <span className="truncate">{t.name}</span>
          </span>
        )
      },
    },
    // Post-Phase-1 (협업개선_설계.md §10.3 data migration), every report
    // lives in the author's personal workspace — so a "부서" column on
    // the report's own workspace_slug would render "박과장(개인)" for
    // every row, which is noise. The "게시" column below now carries
    // the "어느 게시판에 노출되는지" information.
    {
      key: 'phase',
      header: '상태',
      sortable: true,
      headerClassName: 'w-[88px]',
      render: (r) => (
        <Badge variant={PHASE_VARIANT[r.phase] ?? 'secondary'}>
          {PHASE_LABEL[r.phase] ?? r.phase}
        </Badge>
      ),
    },
    {
      key: 'mount_names',
      header: '게시',
      sortable: true,
      headerClassName: 'w-[160px]',
      cellClassName: 'truncate',
      render: (r) => {
        const mounts = r.mount_workspaces ?? []
        // Clicking the cell opens the MountDialog for this row — both
        // the "미게시" state (start mounting) and the chip strip (manage
        // existing mounts) are interactive. stopPropagation so the
        // surrounding TableRow's navigate-to-detail click doesn't fire.
        const openMounts = (e) => {
          e.stopPropagation()
          setMountDialogReport(r)
        }
        if (mounts.length === 0) {
          return (
            <button
              type="button"
              onClick={openMounts}
              className="text-[11px] text-muted-foreground/70 hover:text-foreground underline-offset-2 hover:underline"
              title="이 보고서를 게시판에 게시"
            >
              미게시
            </button>
          )
        }
        const fullText = mounts.map((m) => m.name).join(', ')
        const visible = mounts.slice(0, 2)
        const overflow = mounts.length - visible.length
        return (
          <button
            type="button"
            onClick={openMounts}
            className="inline-flex items-center gap-1 flex-wrap rounded px-1 -mx-1 hover:bg-muted/60 transition-colors"
            title={`${fullText} (클릭: 게시 관리)`}
          >
            {visible.map((m) => (
              <span
                key={m.slug}
                className="inline-flex items-center rounded-full bg-primary/10 text-primary px-1.5 py-0.5 text-[10px] font-medium max-w-[70px] truncate"
              >
                {m.name}
              </span>
            ))}
            {overflow > 0 && (
              <span className="text-[10px] text-muted-foreground">
                +{overflow}
              </span>
            )}
          </button>
        )
      },
    },
    {
      key: 'owner_name',
      header: '작성자',
      sortable: true,
      headerClassName: 'w-[150px]',
      cellClassName: 'truncate',
      render: (r) => {
        // Phase 3 — show last editor when they're someone other than
        // the owner. Helps the "박과장 보고서를 김부장이 손봤다"
        // visibility that's central to the boss-edits-subordinate
        // workflow. Same row, lighter color to keep owner primary.
        const editor = r.last_edited_by_name
        const showEditor =
          editor && r.last_edited_by_user_id !== r.owner_user_id
        return (
          <span
            className="block truncate text-xs text-muted-foreground"
            title={
              r.owner_email
                ? `${r.owner_name} (${r.owner_email})${showEditor ? ` · 최근 수정: ${editor}` : ''}`
                : undefined
            }
          >
            <span className="text-foreground/80">{r.owner_name ?? '—'}</span>
            {showEditor && (
              <span className="text-muted-foreground"> · {editor} 수정</span>
            )}
          </span>
        )
      },
    },
    {
      key: 'updated_at',
      header: '수정일',
      sortable: true,
      headerClassName: 'w-[100px]',
      render: (r) => (
        <span
          className="text-xs text-muted-foreground whitespace-nowrap"
          title={
            r.updated_by_name
              ? `${r.updated_by_name} · ${formatDateTime(r.updated_at)}`
              : formatDateTime(r.updated_at)
          }
        >
          {formatDate(r.updated_at)}
        </span>
      ),
    },
    {
      key: 'report_date',
      header: '보고 기준일',
      sortable: true,
      headerClassName: 'w-[110px]',
      render: (r) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap font-mono">
          {r.report_date ?? '—'}
        </span>
      ),
    },
  ]

  // Drop ids that no longer appear in `list` (filtered out by onlyMine /
  // scope, or removed after a refresh). Keeps the selection count and
  // the bulk-action target set consistent with what the user can see.
  const visibleIdSet = useMemo(() => new Set(list.map((r) => r.id)), [list])
  const effectiveSelected = useMemo(() => {
    const next = new Set()
    for (const id of selectedIds) if (visibleIdSet.has(id)) next.add(id)
    return next
  }, [selectedIds, visibleIdSet])

  /** Generic bulk action over an explicit id list. Pulled out of the
   *  original runBulk so the drag-and-drop handler can run the SAME
   *  toast/refresh pipeline over a one-off id set (e.g. dragging a
   *  single unselected row) without temporarily mutating selectedIds. */
  async function runBulkOnIds(ids, action, { successWord }) {
    if (ids.length === 0) return
    setBulkBusy(true)
    try {
      const results = await Promise.allSettled(ids.map((id) => action(id)))
      const ok = results.filter((r) => r.status === 'fulfilled').length
      const fail = results.length - ok
      if (fail === 0) {
        toast.success(`${ok}건 ${successWord}`)
      } else {
        const firstErr = results.find((r) => r.status === 'rejected')?.reason
        toast.warning(`${ok}건 ${successWord}, ${fail}건 실패`, {
          description:
            firstErr?.response?.data?.message ||
            firstErr?.message ||
            undefined,
        })
      }
      setSelectedIds(new Set())
      reload()
      // FolderSidebar 의 보고서 카운트 갱신 트리거. 이동/삭제 어느 쪽이든
      // 폴더별 숫자가 바뀌므로 단일 진입점에서 한 번에 처리.
      bumpFolderReload()
    } finally {
      setBulkBusy(false)
    }
  }

  function runBulk(action, opts) {
    return runBulkOnIds([...effectiveSelected], action, opts)
  }

  function handleBulkDelete() {
    runBulk((id) => deleteReport(id), { successWord: '삭제됨' })
  }

  /** Bulk folder change — branches on isOrg because the two scopes use
   *  different routes (Report.folder_id vs ReportMount.folder_id). The
   *  same `folderId === null` sentinel means "uncategorized" in both. */
  function moveOne(id, folderId) {
    return isOrg
      ? setMountFolder({ reportId: id, workspaceSlug: slug, folderId })
      : moveReportToFolder(id, folderId)
  }

  function handleBulkMove(folderId) {
    runBulk((id) => moveOne(id, folderId), { successWord: '이동됨' })
  }

  /** Drop target on FolderSidebar fired — `folderId === null` = 미분류.
   *  `ids` is whatever the row-drag carried; it may or may not match
   *  the current selection (we drag the lone row if the drag started
   *  on an unselected row). Filter to visible rows only so a stale id
   *  doesn't sneak through. */
  function handleReportsDropOnFolder(folderId, ids) {
    const visible = (ids ?? []).filter((id) => visibleIdSet.has(id))
    if (visible.length === 0) return
    runBulkOnIds(visible, (id) => moveOne(id, folderId), { successWord: '이동됨' })
  }

  // Bulk unmount — matrix of (selected report × picked workspace).
  // Dialog supplies which workspaces; we walk the selected reports'
  // mount_workspaces to find which (report, ws) pairs actually exist
  // (others are skipped — the report wasn't on that workspace anyway).
  async function handleBulkUnmount(workspaceSlugs) {
    const slugSet = new Set(workspaceSlugs)
    const targets = []
    for (const r of list) {
      if (!effectiveSelected.has(r.id)) continue
      for (const m of r.mount_workspaces ?? []) {
        if (slugSet.has(m.slug)) {
          targets.push({ reportId: r.id, workspaceSlug: m.slug })
        }
      }
    }
    if (targets.length === 0) return
    setBulkBusy(true)
    try {
      const results = await Promise.allSettled(
        targets.map((t) =>
          unmountReport({ reportId: t.reportId, workspaceSlug: t.workspaceSlug }),
        ),
      )
      const ok = results.filter((r) => r.status === 'fulfilled').length
      const fail = results.length - ok
      if (fail === 0) {
        toast.success(`게시 ${ok}건 해제됨`)
      } else {
        const firstErr = results.find((r) => r.status === 'rejected')?.reason
        toast.warning(`${ok}건 해제, ${fail}건 실패`, {
          description:
            firstErr?.response?.data?.message ||
            firstErr?.message ||
            undefined,
        })
      }
      setSelectedIds(new Set())
      reload()
      // org 게시판에서 unmount 하면 그 게시판의 폴더별 카운트도 줄어든다.
      bumpFolderReload()
    } finally {
      setBulkBusy(false)
      setBulkUnmountOpen(false)
    }
  }

  /** Bulk mount — matrix of (선택 보고서 × picked 게시판).
   *  mountReport 가 (report_id, workspace_slugs[]) 묶음 단위로 idempotent
   *  하므로 보고서 단위로 한 번씩만 호출. 작성자가 아닌 보고서는 서버가
   *  403 으로 거절 → Promise.allSettled 의 fail 카운트에 잡혀 토스트에
   *  요약 보고. note / editPolicy 는 모든 보고서에 동일 적용. */
  async function handleBulkMount({ workspaceSlugs, note, editPolicy }) {
    if (!workspaceSlugs || workspaceSlugs.length === 0) return
    const reportIds = list
      .filter((r) => effectiveSelected.has(r.id))
      .map((r) => r.id)
    if (reportIds.length === 0) return
    setBulkBusy(true)
    try {
      const results = await Promise.allSettled(
        reportIds.map((id) =>
          mountReport({
            reportId: id,
            workspaceSlugs,
            editPolicy: editPolicy || 'default',
            note: note || '',
          }),
        ),
      )
      const ok = results.filter((r) => r.status === 'fulfilled').length
      const fail = results.length - ok
      const wsCount = workspaceSlugs.length
      if (fail === 0) {
        toast.success(`${ok}건 × ${wsCount}개 게시판 게시 완료`)
      } else {
        const firstErr = results.find((r) => r.status === 'rejected')?.reason
        toast.warning(`${ok}건 게시, ${fail}건 실패`, {
          description:
            firstErr?.response?.data?.message ||
            firstErr?.message ||
            undefined,
        })
      }
      setSelectedIds(new Set())
      reload()
      // 대상 게시판의 폴더 카운트가 늘어남.
      bumpFolderReload()
    } finally {
      setBulkBusy(false)
      setBulkMountOpen(false)
    }
  }

  return (
    <div className={cn('flex', showFolderSidebar ? 'h-[calc(100vh-3.5rem)]' : 'p-6 space-y-4 flex-col')}>
      {/* 폴더 사이드바 — personal: 그 가입자 트리(personal-{N} 슬러그를
          backend 가 받아 분기), org: 공유 트리. virtual 워크스페이스
          (횡단 view) 에는 폴더 개념 없음. */}
      {showFolderSidebar && (
        <FolderSidebar
          workspaceSlug={isOrg || isPersonal ? slug : undefined}
          canEdit={canEditFolders}
          selected={folderFilter}
          onSelect={setFolderFilter}
          onChanged={reload}
          onReportsDrop={handleReportsDropOnFolder}
          reloadKey={folderReloadKey}
        />
      )}

      <div className={cn('flex-1 overflow-auto', showFolderSidebar && 'p-6 space-y-4')}>
        <PageHeader
          title="보고서"
          description={
            workspace
              ? `${workspace.name} — 총 ${list.length}건${workspace.virtual ? ' (횡단)' : ''}`
              : ''
          }
          actions={
            !workspace?.virtual && (
              <Button onClick={() => navigate(`/w/${slug}/reports/new`)}>
                <Plus className="mr-2 h-4 w-4" />
                신규 작성
              </Button>
            )
          }
        />

        {error ? (
          <ErrorState description={error.message} onRetry={reload} />
        ) : loading ? (
          <Skeleton className="h-96" />
        ) : (
          <>
            {effectiveSelected.size > 0 && (
              <BulkActionBar
                count={effectiveSelected.size}
                busy={bulkBusy}
                canMove={showFolderSidebar}
                workspaceSlug={isOrg || isPersonal ? slug : undefined}
                hasMountsInSelection={list.some(
                  (r) =>
                    effectiveSelected.has(r.id) &&
                    (r.mount_workspaces ?? []).length > 0,
                )}
                onMove={handleBulkMove}
                onMount={() => setBulkMountOpen(true)}
                onDelete={() => setBulkDeleteOpen(true)}
                onUnmount={() => setBulkUnmountOpen(true)}
                onClear={() => setSelectedIds(new Set())}
              />
            )}
            <DataTable
              columns={columns}
              data={list}
              fixedLayout
              // 합산: 선택 40 + 번호 64 + 제목 260 + 템플릿 180 + 종류 140
              //      + 상태 88 + 게시 160 + 작성자 150 + 수정일 100 + 보고기준일 110
              //      ≈ 1292. 컨테이너가 이보다 좁으면 표 자체가 가로
              // 스크롤(overflow-x-auto 는 DataTable container 에 있음).
              minTableWidthClass="min-w-[1290px]"
              defaultSort={{ key: 'id', dir: 'desc' }}
              pageSizeStorageKey="reports"
              searchableKeys={['title', 'template_id', 'owner_name', 'owner_email', 'last_edited_by_name', 'report_type_name', 'mount_names']}
              searchPlaceholder="제목, 템플릿, 게시, 작성자/수정자, 종류 검색"
              onRowClick={(r) => navigate(`/w/${slug}/reports/${r.id}`)}
              selectable
              selectedIds={effectiveSelected}
              onSelectionChange={setSelectedIds}
              rowProps={
                showFolderSidebar
                  ? (row) => {
                      // Drag a row → drag every selected row when the
                      // source is part of the selection; otherwise drag
                      // just this one. Matches Finder / Gmail behavior
                      // (lone drag from unselected row doesn't require
                      // the user to tick a checkbox first).
                      return {
                        draggable: true,
                        onDragStart: (e) => {
                          const ids = effectiveSelected.has(row.id)
                            ? [...effectiveSelected]
                            : [row.id]
                          e.dataTransfer.effectAllowed = 'move'
                          e.dataTransfer.setData(
                            REPORT_DRAG_MIME,
                            JSON.stringify(ids),
                          )
                          // text/plain fallback so the browser still
                          // shows a drag preview / cursor even in older
                          // engines that ignore custom MIME types.
                          e.dataTransfer.setData('text/plain', String(ids.length))
                        },
                      }
                    }
                  : undefined
              }
              toolbarExtras={
                <FilterBar
                  onlyMine={onlyMine}
                  onToggleMine={() => setOnlyMine((v) => !v)}
                  scopeChoices={scopeChoices}
                  scopeSlug={scopeSlug}
                  onScopeSlug={setScopeSlug}
                  myUserId={myUserId}
                  entityFilter={entityFilter}
                  onEntityFilterChange={setEntityFilter}
                  phaseFilter={phaseFilter}
                  onPhaseFilterChange={setPhaseFilter}
                  periodFilter={periodFilter}
                  onPeriodFilterChange={setPeriodFilter}
                  periodYearOptions={periodYearOptions}
                  mountWorkspaceFilter={mountWorkspaceFilter}
                  onMountWorkspaceFilterChange={setMountWorkspaceFilter}
                  mountWorkspaceOptions={mountWorkspaceOptions}
                />
              }
            />
          </>
        )}
        <ConfirmDialog
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          title="선택한 보고서 삭제"
          description={`선택한 ${effectiveSelected.size}건의 보고서를 삭제합니다. 되돌릴 수 없습니다.`}
          confirmLabel="삭제"
          variant="destructive"
          onConfirm={handleBulkDelete}
        />
        <MountDialog
          open={Boolean(mountDialogReport)}
          onOpenChange={(v) => !v && setMountDialogReport(null)}
          report={mountDialogReport}
          onChanged={reload}
        />
        <BulkUnmountDialog
          open={bulkUnmountOpen}
          onOpenChange={(v) => !bulkBusy && setBulkUnmountOpen(v)}
          selectedReports={list.filter((r) => effectiveSelected.has(r.id))}
          busy={bulkBusy}
          onConfirm={handleBulkUnmount}
        />
        <BulkMountDialog
          open={bulkMountOpen}
          onOpenChange={(v) => !bulkBusy && setBulkMountOpen(v)}
          selectedReports={list.filter((r) => effectiveSelected.has(r.id))}
          busy={bulkBusy}
          onConfirm={handleBulkMount}
        />
      </div>
    </div>
  )
}

/** Toolbar with "내 보고서만" toggle + "내 소속" scope picker + entity tag
 *  filter (모델/부품/BOM/단계/불량/시험/시뮬레이션). Hidden entirely when
 *  the user has no membership AND no owner id — there's nothing meaningful
 *  to scope against. */
function FilterBar({
  onlyMine,
  onToggleMine,
  scopeChoices,
  scopeSlug,
  onScopeSlug,
  myUserId,
  entityFilter,
  onEntityFilterChange,
  phaseFilter,
  onPhaseFilterChange,
  periodFilter,
  onPeriodFilterChange,
  periodYearOptions,
  mountWorkspaceFilter,
  onMountWorkspaceFilterChange,
  mountWorkspaceOptions,
}) {
  const hasMembership = scopeChoices.length > 0
  const canFilterByOwner = myUserId != null
  // Phase filter is always available (no permission gate). Keep the
  // early-return only for the rare "no membership + no owner id" case
  // so the whole bar collapses; phase filter alone wouldn't be useful
  // for an unauthenticated/orphan user.
  if (!canFilterByOwner && !hasMembership) return null

  return (
    <div className="flex items-center gap-3 flex-wrap text-xs">
      {canFilterByOwner && (
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={onlyMine}
            onChange={onToggleMine}
            className="h-3.5 w-3.5"
          />
          <span>내 보고서만</span>
        </label>
      )}
      <div className="inline-flex items-center gap-1.5">
        <span className="text-muted-foreground">상태:</span>
        <select
          value={phaseFilter}
          onChange={(e) => onPhaseFilterChange(e.target.value)}
          className="h-7 rounded border border-input bg-background px-1.5 text-xs"
        >
          <option value="">전체</option>
          {PHASES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="inline-flex items-center gap-1.5">
        <span className="text-muted-foreground">기간:</span>
        <select
          value={periodFilter}
          onChange={(e) => onPeriodFilterChange(e.target.value)}
          className="h-7 rounded border border-input bg-background px-1.5 text-xs"
          title="보고서 최근 수정일 기준"
        >
          <option value="">전체</option>
          <option value="d30">최근 30일</option>
          <option value="d90">최근 90일</option>
          <option value="d365">최근 1년</option>
          {periodYearOptions.length > 0 && (
            <optgroup label="특정 연도">
              {periodYearOptions.map((y) => (
                <option key={y} value={`y${y}`}>
                  {y}년
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      {mountWorkspaceOptions.length > 0 && (
        <div className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">게시판:</span>
          <select
            value={mountWorkspaceFilter}
            onChange={(e) => onMountWorkspaceFilterChange(e.target.value)}
            className="h-7 rounded border border-input bg-background px-1.5 text-xs max-w-[160px]"
          >
            <option value="">전체</option>
            {mountWorkspaceOptions.map((ws) => (
              <option key={ws.slug} value={ws.slug}>
                {ws.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {hasMembership && (
        <div className="inline-flex items-center gap-1.5">
          <span className="text-muted-foreground">내 소속:</span>
          <WorkspaceCombobox
            workspaces={scopeChoices}
            value={scopeSlug}
            onChange={onScopeSlug}
            allowNone
            noneLabel="사용 안 함"
            placeholder="사용 안 함"
            searchPlaceholder="부서 이름·슬러그·경로로 검색"
            compact
            className="min-w-[180px] max-w-[280px]"
          />
        </div>
      )}
      <EntityFilterControl
        selected={entityFilter}
        onChange={onEntityFilterChange}
      />
    </div>
  )
}

/**
 * Entity tag filter — a single "필터" popover button (with a selected
 * count badge) opens a panel with one EntityMultiPicker per axis. Picked
 * chips also surface inline next to the button so a glance at the
 * toolbar shows what's currently filtered.
 *
 * The picker reuses EntityMultiPicker — so "+ 새 값 추가" is also live
 * here, by design: a user searching for a model that doesn't exist yet
 * can add it without leaving the list page. The new value lands as
 * `active` and immediately becomes available in the report-settings
 * picker too.
 */
function EntityFilterControl({ selected, onChange }) {
  const [open, setOpen] = useState(false)
  const [types, setTypes] = useState(null)

  // Fetch axes once — small/stable. Triggers on first popover open
  // instead of mount so the list page's initial paint isn't tied to it.
  useEffect(() => {
    if (!open || types !== null) return
    let cancelled = false
    listEntityTypes()
      .then((res) => {
        if (!cancelled) setTypes(res?.items ?? [])
      })
      .catch((e) => {
        if (cancelled) return
        toast.error('축 목록 불러오기 실패', {
          description: String(e?.message ?? e),
        })
      })
    return () => {
      cancelled = true
    }
  }, [open, types])

  const byTypeSlug = useMemo(() => {
    const m = new Map()
    for (const e of selected || []) {
      const slug = e.type_slug ?? ''
      if (!m.has(slug)) m.set(slug, [])
      m.get(slug).push(e)
    }
    return m
  }, [selected])

  function setAxisValue(slug, nextList) {
    const others = (selected || []).filter((e) => (e.type_slug ?? '') !== slug)
    onChange?.([...others, ...nextList])
  }

  function removeOne(id) {
    onChange?.((selected || []).filter((e) => e.id !== id))
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs">
            <Filter className="h-3 w-3" />
            필터
            {selected.length > 0 && (
              <Badge
                variant="secondary"
                className="ml-0.5 h-4 px-1.5 text-[10px] font-normal"
              >
                {selected.length}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[28rem] p-3">
          {types === null && (
            <p className="text-xs text-muted-foreground">불러오는 중...</p>
          )}
          {types !== null && types.length === 0 && (
            <p className="text-xs text-muted-foreground">등록된 축이 없습니다.</p>
          )}
          {types !== null && types.length > 0 && (
            <div className="space-y-2">
              {types.map((t) => (
                <div key={t.id} className="flex items-start gap-3">
                  <Label className="w-20 shrink-0 pt-1.5 text-xs text-muted-foreground">
                    {t.label}
                  </Label>
                  <div className="min-w-0 flex-1">
                    <EntityMultiPicker
                      type={t}
                      value={byTypeSlug.get(t.slug) ?? []}
                      onChange={(next) => setAxisValue(t.slug, next)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>
      {/* Inline chip strip — same shape as the dialog chips so users
          recognize them. Only renders when there's at least one
          selection; otherwise the bar collapses back to just the
          "필터" button. */}
      {selected.map((e) => (
        <span
          key={e.id}
          className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[11px]"
          title={`${e.type_slug}: ${e.value}`}
        >
          <span className="max-w-[10rem] truncate">{e.value}</span>
          <button
            type="button"
            onClick={() => removeOne(e.id)}
            className="-mr-1 ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="필터에서 제거"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {selected.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => onChange?.([])}
        >
          초기화
        </Button>
      )}
    </div>
  )
}

/** Selection action bar — appears only when at least one row is ticked.
 *  Shows the running count, an "이동" popover (when the workspace has
 *  folders), the "삭제" trigger, and a "선택 해제" escape hatch. The bar
 *  itself doesn't own selection state; it's a thin presentation layer
 *  so the parent stays the single source of truth for `selectedIds`. */
function BulkActionBar({
  count,
  busy,
  canMove,
  workspaceSlug,
  hasMountsInSelection,
  onMove,
  onMount,
  onDelete,
  onUnmount,
  onClear,
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-primary/5 px-3 py-2 text-sm">
      <span className="font-medium">{count}건 선택됨</span>
      <div className="ml-auto flex items-center gap-2">
        {canMove && (
          <BulkMovePopover
            workspaceSlug={workspaceSlug}
            disabled={busy}
            onPick={onMove}
          />
        )}
        {/* 일괄 게시 — 게시 정리 의 반대 동작. 선택된 N개 보고서를 한 번에
            여러 게시판에 mount. 본인이 작성자 아닌 보고서는 서버가 거절하고
            나머지만 처리된 뒤 토스트로 ok/fail 카운트 보고. */}
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1"
          onClick={onMount}
          disabled={busy}
          title="선택한 보고서들을 한 번에 여러 게시판에 게시"
        >
          <Link2 className="h-3.5 w-3.5" />
          게시
        </Button>
        {/* 게시 정리 — 선택된 보고서 중 하나라도 mount 가 있어야 의미.
            전혀 없으면 버튼 자체를 숨겨서 dead-end 클릭 방지. */}
        {hasMountsInSelection && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1"
            onClick={onUnmount}
            disabled={busy}
            title="선택한 보고서들의 게시판 게시를 해제"
          >
            <Unlink className="h-3.5 w-3.5" />
            게시 정리
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1 text-destructive hover:text-destructive"
          onClick={onDelete}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          삭제
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-muted-foreground"
          onClick={onClear}
          disabled={busy}
        >
          선택 해제
        </Button>
      </div>
    </div>
  )
}

/** Bulk unmount picker — given the user's selected reports, computes
 *  the distinct workspaces those reports are mounted to (with counts),
 *  lets the user check off workspaces, and on confirm fires unmount
 *  for the matrix of (selected report × picked workspace). The
 *  computation is local — no fetch — because the rows already carry
 *  `mount_workspaces` from the list response. */
function BulkUnmountDialog({
  open,
  onOpenChange,
  selectedReports,
  busy,
  onConfirm,
}) {
  // Distinct workspaces across the selection, with how many reports
  // mount each. Sorted by name for stable order.
  const wsRows = useMemo(() => {
    const map = new Map()
    for (const r of selectedReports) {
      for (const m of r.mount_workspaces ?? []) {
        if (!map.has(m.slug)) {
          map.set(m.slug, { slug: m.slug, name: m.name, count: 0 })
        }
        map.get(m.slug).count += 1
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [selectedReports])

  const [picked, setPicked] = useState(() => new Set())
  // Reset selection whenever the dialog re-opens or the available
  // workspaces change (e.g. user changed row selection while it was
  // closed — stale picks would target workspaces no longer present).
  useEffect(() => {
    if (open) setPicked(new Set())
  }, [open])
  useEffect(() => {
    setPicked((prev) => {
      const valid = new Set(wsRows.map((w) => w.slug))
      const next = new Set()
      for (const s of prev) if (valid.has(s)) next.add(s)
      return next
    })
  }, [wsRows])

  function toggle(slug) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }
  function toggleAll() {
    if (picked.size === wsRows.length) {
      setPicked(new Set())
    } else {
      setPicked(new Set(wsRows.map((w) => w.slug)))
    }
  }

  // Mount-count that would actually be unmounted = sum of counts for
  // picked workspaces.
  const affected = wsRows.reduce(
    (n, w) => n + (picked.has(w.slug) ? w.count : 0),
    0,
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>게시 정리</DialogTitle>
          <DialogDescription>
            선택한 {selectedReports.length}개 보고서가 게시된 게시판입니다.
            해제할 게시판을 고르세요. 보고서 자체는 삭제되지 않고, 해당
            게시판에서만 노출이 사라집니다.
          </DialogDescription>
        </DialogHeader>
        {wsRows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            선택한 보고서들이 어떤 게시판에도 게시되어 있지 않습니다.
          </p>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between px-2 py-1 text-xs text-muted-foreground border-b">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={picked.size === wsRows.length && wsRows.length > 0}
                  ref={(el) => {
                    if (el) {
                      el.indeterminate =
                        picked.size > 0 && picked.size < wsRows.length
                    }
                  }}
                  onChange={toggleAll}
                  className="h-3.5 w-3.5"
                />
                <span>전체 선택</span>
              </label>
              <span>총 {wsRows.length}개 게시판</span>
            </div>
            <div className="max-h-72 overflow-y-auto space-y-0.5">
              {wsRows.map((ws) => (
                <label
                  key={ws.slug}
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={picked.has(ws.slug)}
                    onChange={() => toggle(ws.slug)}
                    className="h-4 w-4"
                  />
                  <span className="flex-1 truncate">{ws.name}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                    {ws.count}건 게시
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            취소
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy || picked.size === 0}
            onClick={() => onConfirm([...picked])}
          >
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {affected}건 게시 해제
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Bulk mount picker — 선택한 N개 보고서를 한 번에 여러 조직 게시판에 mount.
 *  MountDialog 의 트리 + 검색 UI 를 단순화 (per-mount controls 없이 단순
 *  체크박스 트리만). 검색은 같은 정렬 규칙 (이름 완전 일치 → prefix →
 *  substring → 경로) 으로 본체가 먼저 나오도록 정렬. 게시 메모와
 *  편집 정책은 모든 보고서 / 모든 게시판에 동일 적용. */
function BulkMountDialog({
  open,
  onOpenChange,
  selectedReports,
  busy,
  onConfirm,
}) {
  const { all, getDescendantsInclusive, getAncestors, getPath } = useWorkspace()
  const { me } = useAuth()

  // Eligible boards = 사용자가 멤버인 모든 org 워크스페이스. ancestor
  // walk 권한 모델과 동일 — 본부 멤버는 하위 팀 모두에 게시 가능.
  const eligibleSlugs = useMemo(() => {
    const set = new Set()
    for (const m of me?.memberships ?? []) {
      const slug = m.workspace_slug
      if (!slug || slug.startsWith('personal-')) continue
      for (const s of getDescendantsInclusive(slug)) set.add(s)
    }
    return set
  }, [me, getDescendantsInclusive])

  const eligible = useMemo(
    () =>
      all
        .filter(
          (w) =>
            w.kind === 'org' && !w.virtual && eligibleSlugs.has(w.slug),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [all, eligibleSlugs],
  )

  // eligible 만 가지고 부모-자식 서브트리 구성. eligible 에 없는 중간
  // 노드는 표시 안 함 (MountDialog 와 동일 규칙).
  const treeData = useMemo(() => {
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

  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())
  const [picked, setPicked] = useState(() => new Set())
  const [note, setNote] = useState('')

  // dialog 가 열릴 때마다 본인 직접 멤버 라인 펼치고 picked / note 초기화.
  useEffect(() => {
    if (!open) return
    const next = new Set()
    for (const m of me?.memberships ?? []) {
      const slug = m.workspace_slug
      if (!slug || slug.startsWith('personal-')) continue
      next.add(slug)
      for (const a of getAncestors(slug)) next.add(a.slug)
    }
    setExpanded(next)
    setQuery('')
    setPicked(new Set())
    setNote('')
  }, [open, me, getAncestors])

  const trimmedQuery = query.trim().toLowerCase()
  const searching = trimmedQuery.length > 0
  // MountDialog 와 동일한 정렬 점수 규칙 — 본체가 위로 올라오게.
  const searchResults = useMemo(() => {
    if (!searching) return []
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
  function togglePick(slug) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }

  const wsCount = picked.size
  const reportCount = selectedReports.length
  const totalMounts = wsCount * reportCount

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-auto max-w-[min(40rem,92vw)]">
        <DialogHeader>
          <DialogTitle>일괄 게시</DialogTitle>
          <DialogDescription>
            선택한 {reportCount}개 보고서를 한 번에 여러 조직 게시판에 게시합니다.
            본인이 작성자가 아닌 보고서는 자동으로 건너뜁니다. 게시판은 이미
            게시된 것을 다시 골라도 안전합니다 (중복 게시 안 됨).
          </DialogDescription>
        </DialogHeader>

        {eligible.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4">
            게시할 수 있는 조직 게시판이 없습니다. 워크스페이스에 멤버로
            등록되어 있어야 게시 가능합니다.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="조직명 / 경로 검색 (비우면 트리 보기)"
                className="pl-7 h-8 text-sm"
              />
            </div>
            <div className="max-h-72 overflow-y-auto -mx-2 px-2 space-y-0.5">
              {searching ? (
                searchResults.length === 0 ? (
                  <div className="text-xs text-muted-foreground py-4 text-center">
                    매칭되는 조직이 없습니다.
                  </div>
                ) : (
                  searchResults.map((ws) => (
                    <BulkMountRow
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
                      picked={picked.has(ws.slug)}
                      onTogglePick={() => togglePick(ws.slug)}
                    />
                  ))
                )
              ) : (
                <BulkMountTree
                  nodes={treeData.roots}
                  depth={0}
                  childrenOf={treeData.childrenOf}
                  expanded={expanded}
                  onToggleExpand={toggleExpand}
                  picked={picked}
                  onTogglePick={togglePick}
                />
              )}
            </div>

            <div className="border-t pt-3">
              <label className="text-xs text-muted-foreground block mb-1">
                게시 메모 (선택, 모든 게시에 동일 적용)
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
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            취소
          </Button>
          <Button
            type="button"
            disabled={busy || picked.size === 0 || reportCount === 0}
            onClick={() =>
              onConfirm({
                workspaceSlugs: [...picked],
                note,
                editPolicy: 'default',
              })
            }
          >
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {reportCount}건 × {wsCount}개 = {totalMounts}건 게시
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 트리 재귀 렌더 — 펼친 노드의 자식들이 들여쓰기되어 나타남. 검색
 *  모드일 땐 이 컴포넌트를 거치지 않고 평면 결과를 BulkMountRow 로
 *  직접 매핑한다. */
function BulkMountTree({
  nodes,
  depth,
  childrenOf,
  expanded,
  onToggleExpand,
  picked,
  onTogglePick,
}) {
  return nodes.map((ws) => {
    const kids = childrenOf.get(ws.slug) ?? []
    const hasChildren = kids.length > 0
    const isExpanded = expanded.has(ws.slug)
    return (
      <div key={ws.slug}>
        <BulkMountRow
          ws={ws}
          depth={depth}
          hasChildren={hasChildren}
          isExpanded={isExpanded}
          onToggleExpand={hasChildren ? () => onToggleExpand(ws.slug) : null}
          pathLabel=""
          picked={picked.has(ws.slug)}
          onTogglePick={() => onTogglePick(ws.slug)}
        />
        {hasChildren && isExpanded && (
          <BulkMountTree
            nodes={kids}
            depth={depth + 1}
            childrenOf={childrenOf}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            picked={picked}
            onTogglePick={onTogglePick}
          />
        )}
      </div>
    )
  })
}

function BulkMountRow({
  ws,
  depth,
  hasChildren,
  isExpanded,
  onToggleExpand,
  pathLabel,
  picked,
  onTogglePick,
}) {
  return (
    <label
      className="flex items-center gap-1.5 rounded px-1 py-1 text-sm hover:bg-muted/50 cursor-pointer"
      style={{ paddingLeft: 4 + depth * 14 }}
    >
      {/* chevron / spacer — 트리 깊이 정렬 유지 */}
      {hasChildren ? (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            onToggleExpand && onToggleExpand()
          }}
          className="h-4 w-4 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
      ) : (
        <span className="h-4 w-4 inline-block" />
      )}
      <input
        type="checkbox"
        checked={picked}
        onChange={onTogglePick}
        className="h-4 w-4 shrink-0"
      />
      <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="flex-1 truncate">{ws.name}</span>
      {pathLabel && (
        <span className="text-[10px] text-muted-foreground truncate max-w-[12rem]">
          {pathLabel}
        </span>
      )}
    </label>
  )
}

/** Folder picker for bulk move. Lazy-loads the folder list on first
 *  open so the page's initial paint stays light. Renders the folder
 *  tree flat with depth-indented names — same data shape as
 *  FolderSidebar — plus a "미분류" sentinel that maps to folder_id=null.
 *  Move is metadata-only and owner-gated server-side, so rows the
 *  caller doesn't own fall out of the batch as 403 rejections and get
 *  rolled up in the summary toast. */
function BulkMovePopover({ workspaceSlug, disabled, onPick }) {
  const [open, setOpen] = useState(false)
  const [folders, setFolders] = useState(null)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    if (!open || folders !== null) return
    let cancelled = false
    listFolders({ workspaceSlug })
      .then(({ items }) => {
        if (!cancelled) setFolders(items)
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e?.message || String(e))
      })
    return () => {
      cancelled = true
    }
  }, [open, folders, workspaceSlug])

  // Flat (folder, depth) tuples in stable order — children grouped under
  // their parent, with name-indented rendering driven off `depth`.
  const flat = useMemo(() => {
    if (!folders) return []
    const byParent = new Map()
    for (const f of folders) {
      const key = f.parent_id ?? null
      if (!byParent.has(key)) byParent.set(key, [])
      byParent.get(key).push(f)
    }
    const out = []
    function walk(parentKey, depth) {
      for (const f of byParent.get(parentKey) ?? []) {
        out.push({ folder: f, depth })
        walk(f.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [folders])

  function pick(folderId) {
    setOpen(false)
    onPick(folderId)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1"
          disabled={disabled}
        >
          <FolderInput className="h-3.5 w-3.5" />
          폴더 변경
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1">
        {folders === null && !loadError && (
          <div className="flex items-center justify-center py-4 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          </div>
        )}
        {loadError && (
          <p className="px-3 py-2 text-xs text-destructive">{loadError}</p>
        )}
        {folders !== null && !loadError && (
          <div className="max-h-72 overflow-y-auto space-y-0.5">
            <button
              type="button"
              onClick={() => pick(null)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted text-left"
            >
              <Inbox className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="flex-1 truncate">미분류</span>
            </button>
            {flat.length > 0 && <div className="h-px bg-border my-1" />}
            {flat.map(({ folder, depth }) => (
              <button
                key={folder.id}
                type="button"
                onClick={() => pick(folder.id)}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted text-left"
                style={{ paddingLeft: 8 + depth * 12 }}
                title={folder.name}
              >
                <FolderIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="flex-1 truncate">{folder.name}</span>
              </button>
            ))}
            {flat.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                등록된 폴더가 없습니다.
              </p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function makeTemplateNameLookup(templates) {
  const map = new Map((templates ?? []).map((t) => [t.template_id, t.name]))
  return (id) => {
    if (!id) return ''
    const name = map.get(id)
    if (name) return name
    if (id.length > 16) return `${id.slice(0, 8)}…`
    return id
  }
}

/** "2026-05-18" — compact, sortable, no time component. */
function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toISOString().slice(0, 10)
}

/** "2026-05-18 09:10" — full datetime for tooltip. */
function formatDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Distinct `(template_id, template_version)` pairs across a report's pages,
 *  in first-seen order. Falls back to the legacy top-level binding when the
 *  report has no pages payload (e.g. legacy rows pre-multi-page). */
function uniqueTemplatePairs(report) {
  const pages = Array.isArray(report.pages) ? report.pages : []
  if (pages.length === 0) {
    return [[report.template_id, report.template_version]]
  }
  const seen = new Set()
  const out = []
  for (const p of pages) {
    const key = `${p.template_id}@${p.template_version}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push([p.template_id, p.template_version])
  }
  return out
}
