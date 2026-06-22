import { useMemo, useState } from 'react'
import { ArrowRight, FileCode2, Search, Sparkles } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import { EmptyState } from '@/shared/components/EmptyState'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import {
  ScopeCategorySidebar,
  useScopeCategories,
} from '@/shared/components/ScopeCategories'
import { useAsync } from '@/shared/hooks/useAsync'
import { useAuth } from '@/shared/auth/AuthContext'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { listTemplates } from '@/shared/api/templates'
import { listTemplateCategories } from '@/shared/api/templateCategories'
import { cn } from '@/shared/lib/utils'

/**
 * Reusable template picker (scope list + search + cards). Drives both
 * the new-report flow (full-page) and the "+ 페이지 추가" modal in the
 * report detail page.
 *
 * 좌측은 "어디 템플릿인지"(전체/개인/전사/조직별) — 템플릿 관리 화면과 같은
 * 공용 훅(useScopeCategories)으로 분류한다. 범위를 먼저 고르고, 그 안에서
 * (문제 분류 섹션으로 묶인) 템플릿을 고른다.
 *
 * Caller controls layout via `compact` (modal vs page) and gets a callback
 * when a template is chosen.
 */
export function TemplatePicker({ onPick, compact = false, reloadKey, presetCounts }) {
  const [query, setQuery] = useState('')
  const { me } = useAuth()
  const { all: workspaces } = useWorkspace()
  const workspaceName = (s) =>
    (workspaces ?? []).find((w) => w.slug === s)?.name ?? s

  const { data: templates, loading, error, reload } = useAsync(
    () => listTemplates(),
    [reloadKey]
  )
  const { data: categories } = useAsync(() => listTemplateCategories(), [])

  const list = templates ?? []
  const trimmed = query.trim().toLowerCase()
  const searching = trimmed.length > 0

  // "어디 템플릿인지"(전체/개인/전사/조직별) 분류 — 템플릿 관리와 동일한 공용 훅.
  const scope = useScopeCategories(list, {
    currentUserId: me?.user?.id,
    getName: workspaceName,
  })

  // 선택한 범위로 먼저 거른 뒤, 그 안에서만 문제 분류(카테고리)로 묶는다.
  const scoped = useMemo(
    () => list.filter(scope.filter),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, scope.cat]
  )

  const grouped = useMemo(() => {
    const cats = categories ?? []
    const map = new Map(cats.map((c) => [c.slug, { ...c, templates: [] }]))
    if (!map.has('misc')) {
      map.set('misc', { slug: 'misc', name: '기타', templates: [] })
    }
    for (const t of scoped) {
      const bucket = map.get(t.category) ?? map.get('misc')
      bucket.templates.push(t)
    }
    return Array.from(map.values()).filter((g) => g.templates.length > 0)
  }, [scoped, categories])

  // 검색은 선택한 범위 안에서만 한다(좌측 분류를 좁혀둔 의도를 존중).
  const searchHits = useMemo(() => {
    if (!searching) return null
    return scoped.filter(
      (t) =>
        t.name.toLowerCase().includes(trimmed) ||
        (t.description || '').toLowerCase().includes(trimmed) ||
        t.template_id.toLowerCase().includes(trimmed)
    )
  }, [scoped, trimmed, searching])

  if (error) {
    return <ErrorState description={error.message} onRetry={reload} />
  }

  const gridCols = compact
    ? 'grid-cols-1 md:grid-cols-2'
    : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'

  return (
    <div className="flex gap-6 min-h-0">
      <ScopeCategorySidebar
        counts={scope.counts}
        orgGroups={scope.orgGroups}
        cat={scope.cat}
        onChange={scope.setCat}
        mineLabel="개인 (내 템플릿)"
        emptyOrgText="조직 템플릿이 없습니다."
        className="w-44 shrink-0 self-start border-r pr-2"
      />

      <div className="flex-1 min-w-0 space-y-6">
        <div className="relative max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="템플릿 검색 (이름, 설명)"
            className="pl-8"
          />
        </div>

        {loading ? (
          <div className={cn('grid gap-4', gridCols)}>
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
          </div>
        ) : searching ? (
          <SearchResults
            hits={searchHits}
            onPick={onPick}
            gridCols={gridCols}
            presetCounts={presetCounts}
            workspaceName={workspaceName}
          />
        ) : (
          <div className="space-y-8">
            {grouped.length === 0 ? (
              <EmptyState
                title="이 범위에서 사용 가능한 템플릿이 없습니다"
                description="좌측에서 다른 범위(전체·전사·조직별)를 선택하거나, 관리자가 템플릿을 추가하면 여기에 표시됩니다."
              />
            ) : (
              grouped.map((g) => (
                <CategorySection
                  key={g.slug}
                  group={g}
                  onPick={onPick}
                  gridCols={gridCols}
                  presetCounts={presetCounts}
                  workspaceName={workspaceName}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function CategorySection({ group, onPick, gridCols, presetCounts, workspaceName }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {group.name}
        </h2>
        <span className="text-xs text-muted-foreground">({group.templates.length})</span>
      </div>
      <div className={cn('grid gap-4', gridCols)}>
        {group.templates.map((t) => (
          <TemplateCard
            key={`${t.template_id}-${t.version}`}
            template={t}
            onPick={onPick}
            presetCount={presetCounts?.[t.template_id] ?? 0}
            workspaceName={workspaceName}
          />
        ))}
      </div>
    </section>
  )
}

function SearchResults({ hits, onPick, gridCols, presetCounts, workspaceName }) {
  if (!hits || hits.length === 0) {
    return (
      <EmptyState
        icon={Search}
        title="일치하는 템플릿이 없습니다"
        description="검색어를 다르게 시도하거나 좌측 범위에서 둘러보세요."
      />
    )
  }
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-3">검색 결과 {hits.length}건</div>
      <div className={cn('grid gap-4', gridCols)}>
        {hits.map((t) => (
          <TemplateCard
            key={`${t.template_id}-${t.version}`}
            template={t}
            onPick={onPick}
            presetCount={presetCounts?.[t.template_id] ?? 0}
            workspaceName={workspaceName}
          />
        ))}
      </div>
    </div>
  )
}

function TemplateCard({ template, onPick, presetCount = 0, workspaceName }) {
  const sectionTitles = Object.values(template.schema?.properties ?? {})
    .map((p) => p?.title)
    .filter(Boolean)

  // 범위 배지 — 빈 owner_workspace_slugs = 전사, 아니면 소속 조직(들).
  const orgSlugs = Array.isArray(template.owner_workspace_slugs)
    ? template.owner_workspace_slugs
    : []
  const isGlobal = orgSlugs.length === 0

  return (
    <Card className="flex flex-col">
      <CardHeader className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <FileCode2 className="h-4 w-4 text-muted-foreground shrink-0" />
            <CardTitle className="text-base truncate">{template.name}</CardTitle>
          </div>
          <Badge variant="outline" className="shrink-0">
            v{template.version}
          </Badge>
        </div>
        <CardDescription className="line-clamp-2">{template.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 flex flex-wrap items-center gap-1">
          <span>섹션 {sectionTitles.length}개</span>
          {isGlobal ? (
            <Badge variant="secondary" className="text-[9px]">
              전사
            </Badge>
          ) : (
            orgSlugs.map((s) => (
              <Badge key={s} variant="secondary" className="text-[9px]">
                {workspaceName ? workspaceName(s) : s}
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
        <ul className="text-sm space-y-1 flex-1">
          {sectionTitles.map((title, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="h-1 w-1 rounded-full bg-muted-foreground" />
              <span className="truncate">{title}</span>
            </li>
          ))}
        </ul>
        <Button onClick={() => onPick(template)} className="mt-4 w-full">
          <Sparkles className="mr-2 h-3.5 w-3.5" />
          이 템플릿으로 작성
          <ArrowRight className="ml-auto h-3.5 w-3.5" />
        </Button>
      </CardContent>
    </Card>
  )
}
