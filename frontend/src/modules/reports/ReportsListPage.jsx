import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Filter, Plus, ShieldCheck, ShieldQuestion, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { Label } from '@/shared/components/ui/label'
import { DataTable } from '@/shared/components/DataTable'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { WorkspaceCombobox } from '@/shared/components/WorkspaceCombobox'
import { useAuth } from '@/shared/auth/AuthContext'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listReports } from './api'
import { listTemplates } from '@/shared/api/templates'
import { listEntityTypes } from '@/shared/api/entities'
import { EntityMultiPicker } from '@/modules/entities/EntityMultiPicker'
import { STATUS_LABEL, STATUS_VARIANT } from './constants'

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
  useEffect(() => {
    setEntityFilter([])
  }, [slug])
  const entityFilterIds = useMemo(
    () => entityFilter.map((e) => e.id),
    [entityFilter],
  )
  // `entityFilterKey` is a stable string so the useAsync dep array
  // doesn't re-fire on every render — arrays of ids would be a new
  // reference each pass even when the contents match.
  const entityFilterKey = entityFilterIds.join(',')
  const { data: reports, loading, error, reload } = useAsync(
    () =>
      slug
        ? listReports({ entityIds: entityFilterIds })
        : Promise.resolve([]),
    [slug, entityFilterKey]
  )
  const { data: templates } = useAsync(
    () => (slug ? listTemplates() : Promise.resolve([])),
    [slug]
  )
  const templateName = makeTemplateNameLookup(templates)
  const workspaceName = makeWorkspaceNameLookup(workspaces)

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

  // Annotate each row with the resolved 부서명 so DataTable's substring
  // search hits the Korean name too (it only inspects the row's own keys).
  // Filter `onlyMine` / `scopedSet` here so the visible total and the
  // table contents stay consistent.
  const list = (reports ?? [])
    .filter((r) => !onlyMine || r.owner_user_id === myUserId)
    .filter((r) => !scopedSet || scopedSet.has(r.workspace_slug))
    .map((r) => ({
      ...r,
      workspace_name: workspaceName(r.workspace_slug),
      // Flatten the embedded report_type ref into a sortable/searchable
      // string so DataTable's column sort + substring search both work
      // without bespoke comparators. `report_type` itself is kept around
      // for the cell renderer's badge.
      report_type_name: r.report_type?.name ?? '',
    }))

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
      cellClassName: 'font-medium truncate',
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
    {
      key: 'workspace_slug',
      header: '부서',
      sortable: true,
      headerClassName: 'w-[110px]',
      cellClassName: 'truncate',
      render: (r) => (
        <span
          className="block truncate text-xs text-muted-foreground"
          title={r.workspace_slug}
        >
          {workspaceName(r.workspace_slug)}
        </span>
      ),
    },
    {
      key: 'status',
      header: '상태',
      sortable: true,
      headerClassName: 'w-[88px]',
      render: (r) => <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge>,
    },
    {
      key: 'owner_name',
      header: '작성자',
      sortable: true,
      headerClassName: 'w-[110px]',
      cellClassName: 'truncate',
      render: (r) => (
        <span
          className="block truncate text-xs text-muted-foreground"
          title={r.owner_email ? `${r.owner_name} (${r.owner_email})` : undefined}
        >
          {r.owner_name ?? '—'}
        </span>
      ),
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

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="보고서"
        description={
          workspace ? `${workspace.name} — 총 ${list.length}건${workspace.virtual ? ' (횡단)' : ''}` : ''
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
        <DataTable
          columns={columns}
          data={list}
          fixedLayout
          // 번호 큰 순 (최신 보고서가 위) — 게시판 번호 mental model
          // 에 맞춤. 사용자는 컬럼 헤더 클릭으로 다른 키로 바꿀 수 있음.
          defaultSort={{ key: 'id', dir: 'desc' }}
          pageSizeStorageKey="reports"
          searchableKeys={['title', 'template_id', 'workspace_slug', 'workspace_name', 'owner_name', 'owner_email', 'report_type_name']}
          searchPlaceholder="제목, 템플릿, 부서, 작성자, 종류 검색"
          onRowClick={(r) => navigate(`/w/${slug}/reports/${r.id}`)}
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
            />
          }
        />
      )}
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
}) {
  const hasMembership = scopeChoices.length > 0
  const canFilterByOwner = myUserId != null
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

function makeWorkspaceNameLookup(workspaces) {
  const map = new Map((workspaces ?? []).map((w) => [w.slug, w.name]))
  return (slug) => {
    if (!slug) return ''
    return map.get(slug) ?? slug
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
