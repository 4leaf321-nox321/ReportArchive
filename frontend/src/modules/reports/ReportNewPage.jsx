import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, FileCode2, Search, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/shared/components/PageHeader'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Badge } from '@/shared/components/ui/badge'
import { EmptyState } from '@/shared/components/EmptyState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import {
  ScopeCategorySidebar,
  useScopeCategories,
} from '@/shared/components/ScopeCategories'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAuth } from '@/shared/auth/AuthContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listPresets, newReportFromPreset } from '@/shared/api/presets'
import { listTemplates } from '@/shared/api/templates'
import { listTemplateCategories } from '@/shared/api/templateCategories'
import { cn } from '@/shared/lib/utils'

/** Edit-policy options for the "같이 게시" dropdown. Mirrors
 *  MountDialog.POLICY_OPTIONS so labels stay consistent — kept inline
 *  here to avoid a cross-file import for a 3-row constant. Policy can
 *  always be changed afterward from the report's 게시 다이얼로그. */
const CREATE_POLICY_OPTIONS = [
  { value: 'default',    label: '기본 (작성자 + 보직장)' },
  { value: 'owner_only', label: '작성자 전용' },
  { value: 'coauthor',   label: '공동 작성 (게시판 멤버 전원)' },
]

const isPersonalSlug = (s) => String(s).startsWith('personal-')

/** 한 항목이 속한 카테고리 slug — 컨트롤드 보캐뷸러리에 없으면 'misc'.
 *  TemplatePicker 의 grouping 과 동일 규칙(레거시 죽은 slug 흡수). */
function categorySlugOf(template, knownSlugs) {
  return knownSlugs.has(template.category) ? template.category : 'misc'
}

/**
 * 새 보고서 — 한 화면 3분할(분류·소속 → 템플릿 → 프리셋+시작).
 *
 * 기존엔 전체페이지 TemplatePicker + 별도 모달(NameReportDialog)로 나뉘어,
 * 프리셋이 많아지면 모달의 좁은 스크롤 목록에서 찾기 어려웠다. 이제 한
 * 페이지에서 분류·소속으로 좁히고(①), 템플릿을 고르고(②), 그 템플릿의
 * 프리셋을 검색·필터·정렬로 추려 바로 시작(③)한다.
 *
 * TemplatePicker 는 보고서 상세의 "+ 페이지 추가"(compact)에서 계속 쓰이므로
 * 건드리지 않고, 이 페이지는 같은 공용 훅(useScopeCategories)만 재사용한다.
 */
export default function ReportNewPage() {
  const { slug, workspace } = useWorkspace()
  const { me } = useAuth()
  const navigate = useNavigate()
  const { all: workspaces } = useWorkspace()
  const workspaceName = (s) =>
    (workspaces ?? []).find((w) => w.slug === s)?.name ?? s

  // 작성 picker — 모든 사용자가 모든 부서 템플릿/프리셋으로 시작할 수 있어야
  // 하므로(내 공간 포함) 소유 부서 무관 전체(scope:'all').
  const { data: templates, loading } = useAsync(
    () => listTemplates({ scope: 'all' }),
    [slug],
  )
  const { data: categories } = useAsync(() => listTemplateCategories(), [])
  const { data: presets } = useAsync(() => listPresets({ scope: 'all' }), [slug])

  const presetsByTemplate = useMemo(() => {
    const map = new Map()
    for (const p of presets ?? []) {
      if (!map.has(p.template_id)) map.set(p.template_id, [])
      map.get(p.template_id).push(p)
    }
    return map
  }, [presets])
  const presetCountOf = (tid) => presetsByTemplate.get(tid)?.length ?? 0

  const list = templates ?? []
  // 조직별 트리용 — 전체 org 워크스페이스(가상 제외).
  const orgWorkspaces = useMemo(
    () => (workspaces ?? []).filter((w) => w.kind === 'org' && !w.virtual),
    [workspaces],
  )
  // ① 소속(전체/개인/전사/조직별) — 템플릿 관리와 동일한 공용 훅.
  const scope = useScopeCategories(list, {
    currentUserId: me?.user?.id,
    getName: workspaceName,
    orgWorkspaces,
  })
  const scoped = useMemo(
    () => list.filter(scope.filter),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, scope.cat],
  )

  // ① 분류(카테고리) — 선택한 소속 안에서 템플릿이 있는 분류만, 정렬순으로.
  const [category, setCategory] = useState('all') // 'all' | slug
  const knownCats = useMemo(() => {
    const m = new Map((categories ?? []).map((c) => [c.slug, c]))
    if (!m.has('misc')) m.set('misc', { slug: 'misc', name: '기타', sort_order: 999 })
    return m
  }, [categories])
  const categoryList = useMemo(() => {
    const counts = new Map()
    for (const t of scoped) {
      const cs = categorySlugOf(t, knownCats)
      counts.set(cs, (counts.get(cs) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([cs, count]) => ({
        slug: cs,
        count,
        name: knownCats.get(cs)?.name ?? cs,
        sort: knownCats.get(cs)?.sort_order ?? 500,
      }))
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
  }, [scoped, knownCats])
  // 소속을 바꿔 현재 분류가 사라지면 '전체'로 되돌린다(빈 ② 방지).
  useEffect(() => {
    if (category !== 'all' && !categoryList.some((c) => c.slug === category)) {
      setCategory('all')
    }
  }, [categoryList, category])

  // ② 템플릿 — 소속·분류로 좁힌 뒤 검색.
  const [query, setQuery] = useState('')
  const visibleTemplates = useMemo(() => {
    let arr = scoped
    if (category !== 'all') {
      arr = arr.filter((t) => categorySlugOf(t, knownCats) === category)
    }
    const q = query.trim().toLowerCase()
    if (q) {
      arr = arr.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.description || '').toLowerCase().includes(q) ||
          t.template_id.toLowerCase().includes(q),
      )
    }
    return arr
  }, [scoped, category, query, knownCats])

  const [selectedTemplate, setSelectedTemplate] = useState(null)

  // "이 부서에 같이 게시" 는 부서 컨텍스트에서 진입했을 때만 의미. 개인/virtual
  // 진입에선 게시 섹션 자체를 숨긴다.
  const defaultMount =
    workspace?.kind === 'org' && !workspace.virtual
      ? { slug: workspace.slug, name: workspace.name }
      : null

  function handleConfirm(title, mountConfig) {
    if (!selectedTemplate) return
    navigate(
      `/w/${slug}/reports/new/${selectedTemplate.template_id}/${selectedTemplate.version}`,
      { state: { initialTitle: title, mountConfig } },
    )
  }

  async function handleStartFromPreset(presetId, title) {
    try {
      const created = await newReportFromPreset(presetId, { title })
      navigate(`/w/${created.workspace_slug}/reports/${created.id}`, {
        state: { startEditing: true },
      })
    } catch (err) {
      toast.error(err?.message || '프리셋으로 시작 실패')
      throw err
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6 lg:h-[calc(100vh-3.5rem)]">
      <PageHeader
        title="새 보고서"
        description={`${workspace?.name ?? ''}에 작성할 보고서를 분류 → 템플릿 → 시작 양식(프리셋) 순으로 고르세요.`}
        breadcrumbs={[
          { label: workspace?.name ?? '부서', to: `/w/${slug}` },
          { label: '보고서', to: `/w/${slug}/reports` },
          { label: '새 보고서' },
        ]}
        className="shrink-0"
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        {/* ① 분류 + 소속 */}
        <aside className="shrink-0 space-y-4 lg:w-52 lg:overflow-y-auto lg:border-r lg:pr-3">
          <div>
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              분류
            </div>
            <div className="space-y-0.5">
              <CatRow
                label="전체"
                count={scoped.length}
                active={category === 'all'}
                onClick={() => setCategory('all')}
              />
              {categoryList.map((c) => (
                <CatRow
                  key={c.slug}
                  label={c.name}
                  count={c.count}
                  active={category === c.slug}
                  onClick={() => setCategory(c.slug)}
                />
              ))}
            </div>
          </div>
          <div>
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              소속
            </div>
            <ScopeCategorySidebar
              counts={scope.counts}
              orgGroups={scope.orgGroups}
              orgTree={scope.orgTree}
              orgRollup={scope.rollup}
              onOrgRollupChange={scope.setRollup}
              cat={scope.cat}
              onChange={scope.setCat}
              mineLabel="개인 (내 템플릿)"
              emptyOrgText="조직 템플릿이 없습니다."
            />
          </div>
        </aside>

        {/* ② 템플릿 */}
        <section className="flex min-h-0 flex-col gap-3 lg:w-80 lg:shrink-0 lg:border-r lg:pr-3">
          <div className="relative shrink-0">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="템플릿 검색 (이름·설명)"
              className="h-9 pl-8"
            />
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {loading ? (
              <>
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </>
            ) : visibleTemplates.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                이 범위에 템플릿이 없습니다. 좌측에서 다른 분류·소속을 골라 보세요.
              </p>
            ) : (
              visibleTemplates.map((t) => (
                <TemplateRow
                  key={`${t.template_id}-${t.version}`}
                  template={t}
                  active={
                    selectedTemplate?.template_id === t.template_id &&
                    selectedTemplate?.version === t.version
                  }
                  presetCount={presetCountOf(t.template_id)}
                  workspaceName={workspaceName}
                  onClick={() => setSelectedTemplate(t)}
                />
              ))
            )}
          </div>
        </section>

        {/* ③ 프리셋 + 시작 */}
        <section className="flex min-h-0 flex-1 flex-col lg:min-w-0">
          {selectedTemplate ? (
            <StartPanel
              key={`${selectedTemplate.template_id}-${selectedTemplate.version}`}
              template={selectedTemplate}
              presets={presetsByTemplate.get(selectedTemplate.template_id) ?? []}
              currentUserId={me?.user?.id}
              workspaceName={workspaceName}
              defaultMount={defaultMount}
              onConfirm={handleConfirm}
              onStartFromPreset={handleStartFromPreset}
            />
          ) : (
            <EmptyState
              icon={FileCode2}
              title="템플릿을 선택하세요"
              description="가운데 목록에서 템플릿을 고르면, 여기에서 시작 양식(프리셋)을 고르고 제목을 정해 바로 작성을 시작할 수 있습니다."
            />
          )}
        </section>
      </div>
    </div>
  )
}

/** ① 분류 한 줄 — 라벨 + 건수(소속 사이드바 CategoryButton 과 동형). */
function CatRow({ label, count, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
        active ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {count}
      </span>
    </button>
  )
}

/** ② 템플릿 한 줄 — 카드 대신 좁은 행(3분할 폭에 맞춤). 이름·버전·섹션수·
 *  소속뱃지·프리셋 수. 클릭하면 선택(③ 채움). */
function TemplateRow({ template, active, presetCount, workspaceName, onClick }) {
  const sectionCount = Object.keys(template.schema?.properties ?? {}).length
  const orgSlugs = Array.isArray(template.owner_workspace_slugs)
    ? template.owner_workspace_slugs
    : []
  const isGlobal = orgSlugs.length === 0
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors',
        active ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
      )}
    >
      <div className="flex items-center gap-2">
        <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {template.name}
        </span>
        <Badge variant="outline" className="shrink-0 text-[9px]">
          v{template.version}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-1 pl-6 text-[11px] text-muted-foreground">
        <span>섹션 {sectionCount}개</span>
        {isGlobal ? (
          <Badge variant="secondary" className="text-[9px]">
            전사
          </Badge>
        ) : (
          orgSlugs.map((s) => (
            <Badge key={s} variant="secondary" className="text-[9px]">
              {workspaceName(s)}
            </Badge>
          ))
        )}
        {presetCount > 0 && (
          <Badge className="text-[9px]">
            <Sparkles className="mr-0.5 h-2.5 w-2.5" />
            프리셋 {presetCount}개
          </Badge>
        )}
      </div>
    </button>
  )
}

const PRESET_SORTS = [
  { v: 'recent', label: '최근 수정순' },
  { v: 'name', label: '이름순' },
  { v: 'mine', label: '내 것 먼저' },
]

/** ③ 선택한 템플릿의 시작 패널 — 프리셋 선택기(검색·소속·정렬·메타) + 제목 +
 *  (부서+빈보고서) 게시옵션 + 시작. 템플릿이 바뀌면 key 로 통째 remount 되어
 *  내부 상태(제목·선택·필터)가 깔끔히 초기화된다. */
function StartPanel({
  template,
  presets,
  currentUserId,
  workspaceName,
  defaultMount,
  onConfirm,
  onStartFromPreset,
}) {
  const [title, setTitle] = useState(template?.name ?? '')
  const [selectedPresetId, setSelectedPresetId] = useState(null) // null = 빈
  const [submitting, setSubmitting] = useState(false)
  const [autoMount, setAutoMount] = useState(true)
  const [editPolicy, setEditPolicy] = useState('default')
  // 프리셋 필터들
  const [pQuery, setPQuery] = useState('')
  const [pScope, setPScope] = useState('all') // 'all'|'global'|'mine'|'org:<slug>'
  const [pSort, setPSort] = useState('recent')

  const isBlank = selectedPresetId == null
  const hasPresets = (presets?.length ?? 0) > 0

  // 소속 드롭다운 옵션 — 실제 프리셋에 존재하는 소속만 노출.
  const scopeOptions = useMemo(() => {
    const opts = [{ v: 'all', label: '전체 소속' }]
    let hasGlobal = false
    let hasMine = false
    const orgs = new Map()
    for (const p of presets ?? []) {
      const owners = p.owner_workspace_slugs ?? []
      if (owners.length === 0) {
        hasGlobal = true
      } else if (owners.every(isPersonalSlug)) {
        if (p.created_by_user_id === currentUserId) hasMine = true
      } else {
        for (const s of owners) if (!isPersonalSlug(s)) orgs.set(s, workspaceName(s))
      }
    }
    if (hasGlobal) opts.push({ v: 'global', label: '전사' })
    for (const [s, name] of [...orgs.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
      opts.push({ v: `org:${s}`, label: name })
    }
    if (hasMine) opts.push({ v: 'mine', label: '내 비공개' })
    return opts
  }, [presets, currentUserId, workspaceName])

  const matchScope = (p) => {
    const owners = p.owner_workspace_slugs ?? []
    if (pScope === 'all') return true
    if (pScope === 'global') return owners.length === 0
    if (pScope === 'mine')
      return (
        owners.length > 0 &&
        owners.every(isPersonalSlug) &&
        p.created_by_user_id === currentUserId
      )
    if (pScope.startsWith('org:')) return owners.includes(pScope.slice(4))
    return true
  }

  const filteredPresets = useMemo(() => {
    const q = pQuery.trim().toLowerCase()
    const arr = (presets ?? []).filter(matchScope).filter((p) => {
      if (!q) return true
      return (
        (p.name ?? '').toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q) ||
        (p.created_by_name ?? '').toLowerCase().includes(q)
      )
    })
    const byRecent = (a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
    if (pSort === 'name') arr.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    else if (pSort === 'mine')
      arr.sort((a, b) => {
        const am = a.created_by_user_id === currentUserId ? 0 : 1
        const bm = b.created_by_user_id === currentUserId ? 0 : 1
        return am - bm || byRecent(a, b)
      })
    else arr.sort(byRecent)
    return arr
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presets, pQuery, pScope, pSort, currentUserId])

  function selectOption(presetId) {
    setSelectedPresetId(presetId)
    // 제목 기본값을 선택지에 맞춰 재시드(이어서 수정 가능).
    if (presetId == null) setTitle(template?.name ?? '')
    else
      setTitle(
        (presets ?? []).find((p) => p.id === presetId)?.name ??
          template?.name ??
          '',
      )
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) return
    if (!isBlank) {
      setSubmitting(true)
      try {
        await onStartFromPreset(selectedPresetId, trimmed)
      } catch {
        setSubmitting(false)
      }
      return
    }
    const mountConfig =
      defaultMount && autoMount
        ? { slugs: [defaultMount.slug], editPolicy }
        : null
    onConfirm(trimmed, mountConfig)
  }

  return (
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h2 className="truncate text-sm font-semibold">{template.name}</h2>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          시작 양식(프리셋)을 고르거나 빈 보고서로 시작하세요.
        </p>
      </div>

      {/* 제목 + 게시옵션 + 시작 — 상단 고정(프리셋 목록보다 위) */}
      <div className="shrink-0 space-y-2 border-b pb-3">
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <label htmlFor="new-report-title" className="text-xs font-medium">
              보고서 제목
            </label>
            <Input
              id="new-report-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="예) 2026-W20 주간보고"
              required
            />
          </div>
          <Button type="submit" disabled={!title.trim() || submitting}>
            {submitting ? (
              '시작하는 중…'
            ) : (
              <>
                <Sparkles className="mr-2 h-3.5 w-3.5" />
                작성 시작
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </>
            )}
          </Button>
        </div>

        {/* 게시 섹션 — 부서 진입 + 빈 보고서일 때만(프리셋은 개인 공간 seed). */}
        {isBlank && defaultMount && (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={autoMount}
                onChange={(e) => setAutoMount(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <div className="text-sm">
                <div>
                  작성 후{' '}
                  <span className="font-medium">{defaultMount.name}</span> 게시판에
                  같이 게시
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  보고서는 내 공간에 저장되고, 이 게시판에 link 되어 부서 멤버가
                  열람·코멘트할 수 있습니다.
                </p>
              </div>
            </label>
            {autoMount && (
              <div className="flex items-center gap-2 pl-6">
                <span className="shrink-0 text-xs text-muted-foreground">
                  편집 권한:
                </span>
                <select
                  value={editPolicy}
                  onChange={(e) => setEditPolicy(e.target.value)}
                  className="h-7 flex-1 rounded border border-input bg-background px-1.5 text-xs"
                >
                  {CREATE_POLICY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 프리셋 필터 — 검색 / 소속 / 정렬 (프리셋이 있을 때만) */}
      {hasPresets && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="relative min-w-[10rem] flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={pQuery}
              onChange={(e) => setPQuery(e.target.value)}
              placeholder="프리셋 검색 (이름·설명·작성자)"
              className="h-8 pl-8 text-xs"
            />
          </div>
          {scopeOptions.length > 1 && (
            <select
              value={pScope}
              onChange={(e) => setPScope(e.target.value)}
              className="h-8 rounded border bg-background px-2 text-xs"
              title="소속으로 거르기"
            >
              {scopeOptions.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <select
            value={pSort}
            onChange={(e) => setPSort(e.target.value)}
            className="h-8 rounded border bg-background px-2 text-xs"
            title="정렬"
          >
            {PRESET_SORTS.map((o) => (
              <option key={o.v} value={o.v}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* 시작 방식 — 빈 보고서 + 프리셋 카드(2열) */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <button
          type="button"
          onClick={() => selectOption(null)}
          className={cn(
            'mb-1.5 flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors',
            isBlank ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
          )}
        >
          <RadioDot active={isBlank} />
          <span className="min-w-0">
            <span className="block text-sm font-medium">빈 보고서로 시작</span>
            <span className="block text-[11px] text-muted-foreground">
              프리셋 없이 템플릿 구조만 — 내용은 비어 있음
            </span>
          </span>
        </button>

        {hasPresets &&
          (filteredPresets.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              조건에 맞는 프리셋이 없습니다.
            </p>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {filteredPresets.map((p) => (
                <PresetOption
                  key={p.id}
                  preset={p}
                  active={selectedPresetId === p.id}
                  workspaceName={workspaceName}
                  onClick={() => selectOption(p.id)}
                />
              ))}
            </div>
          ))}
      </div>
    </form>
  )
}

/** 프리셋 한 칸 — ✦ 이름 + 작성자·소속·최근수정일 메타 + 설명. 메타로 동명
 *  프리셋을 구분한다. 날짜는 date-only 라 slice 로 충분(tz 영향 미미). */
function PresetOption({ preset, active, workspaceName, onClick }) {
  const owners = preset.owner_workspace_slugs ?? []
  const scopeLabel =
    owners.length === 0
      ? '전사'
      : owners.every(isPersonalSlug)
        ? '개인'
        : owners
            .filter((s) => !isPersonalSlug(s))
            .map(workspaceName)
            .join('·')
  const updated = preset.updated_at ? String(preset.updated_at).slice(0, 10) : null
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors',
        active ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
      )}
    >
      <RadioDot active={active} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-sm font-medium">
          <Sparkles className="h-3 w-3 shrink-0 text-primary" />
          <span className="truncate">{preset.name}</span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-muted-foreground">
          {preset.created_by_name && <span>{preset.created_by_name}</span>}
          <Badge variant="secondary" className="text-[9px]">
            {scopeLabel}
          </Badge>
          {updated && <span>· {updated}</span>}
        </span>
        {preset.description && (
          <span className="mt-0.5 block line-clamp-2 text-[11px] text-muted-foreground">
            {preset.description}
          </span>
        )}
      </span>
    </button>
  )
}

/** 라디오형 선택 점 — StartOption/PresetOption 공용. */
function RadioDot({ active }) {
  return (
    <span
      className={cn(
        'mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border',
        active ? 'border-primary bg-primary' : 'border-muted-foreground/40',
      )}
      aria-hidden
    />
  )
}
