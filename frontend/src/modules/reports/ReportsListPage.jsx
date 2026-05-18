import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
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
  const { data: reports, loading, error, reload } = useAsync(
    () => (slug ? listReports() : Promise.resolve([])),
    [slug]
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
    }))

  const columns = [
    { key: 'title', header: '제목', sortable: true, cellClassName: 'font-medium' },
    {
      key: 'template_id',
      header: '템플릿',
      sortable: true,
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
            className="block truncate text-xs text-muted-foreground max-w-[260px]"
            title={fullText}
          >
            {fullText}
          </span>
        )
      },
    },
    {
      key: 'workspace_slug',
      header: '부서',
      sortable: true,
      render: (r) => (
        <span
          className="text-xs text-muted-foreground"
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
      render: (r) => <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge>,
    },
    {
      key: 'owner_name',
      header: '작성자',
      sortable: true,
      render: (r) => (
        <span
          className="text-xs text-muted-foreground"
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
          searchableKeys={['title', 'template_id', 'workspace_slug', 'workspace_name', 'owner_name', 'owner_email']}
          searchPlaceholder="제목, 템플릿, 부서, 작성자 검색"
          onRowClick={(r) => navigate(`/w/${slug}/reports/${r.id}`)}
          toolbarExtras={
            <FilterBar
              onlyMine={onlyMine}
              onToggleMine={() => setOnlyMine((v) => !v)}
              scopeChoices={scopeChoices}
              scopeSlug={scopeSlug}
              onScopeSlug={setScopeSlug}
              myUserId={myUserId}
            />
          }
        />
      )}
    </div>
  )
}

/** Toolbar with "내 보고서만" toggle + "내 소속" scope picker.
 *  Hidden when the user has no membership (e.g. admin with empty
 *  memberships array) — there's nothing meaningful to scope against. */
function FilterBar({
  onlyMine,
  onToggleMine,
  scopeChoices,
  scopeSlug,
  onScopeSlug,
  myUserId,
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
