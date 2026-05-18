import { useMemo, useState } from 'react'
import { ArrowRight, FileCode2, Search, Sparkles } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import { EmptyState } from '@/shared/components/EmptyState'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { useAsync } from '@/shared/hooks/useAsync'
import { listTemplates } from '@/shared/api/templates'
import { listTemplateCategories } from '@/shared/api/templateCategories'
import { cn } from '@/shared/lib/utils'

const ALL = '_all'

/**
 * Reusable template picker (category list + search + cards). Drives both
 * the new-report flow (full-page) and the "+ 페이지 추가" modal in the
 * report detail page.
 *
 * Caller controls layout via `compact` (modal vs page) and gets a callback
 * when a template is chosen.
 */
export function TemplatePicker({ onPick, compact = false, reloadKey }) {
  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState(ALL)
  const { data: templates, loading, error, reload } = useAsync(
    () => listTemplates(),
    [reloadKey]
  )
  const { data: categories } = useAsync(() => listTemplateCategories(), [])

  const list = templates ?? []
  const trimmed = query.trim().toLowerCase()
  const searching = trimmed.length > 0

  const grouped = useMemo(() => {
    const cats = categories ?? []
    const map = new Map(cats.map((c) => [c.slug, { ...c, templates: [] }]))
    if (!map.has('misc')) {
      map.set('misc', { slug: 'misc', name: '기타', templates: [] })
    }
    for (const t of list) {
      const bucket = map.get(t.category) ?? map.get('misc')
      bucket.templates.push(t)
    }
    return Array.from(map.values()).filter((g) => g.templates.length > 0)
  }, [list, categories])

  const searchHits = useMemo(() => {
    if (!searching) return null
    return list.filter(
      (t) =>
        t.name.toLowerCase().includes(trimmed) ||
        (t.description || '').toLowerCase().includes(trimmed) ||
        t.template_id.toLowerCase().includes(trimmed)
    )
  }, [list, trimmed, searching])

  const visibleGroups =
    activeCategory === ALL ? grouped : grouped.filter((g) => g.slug === activeCategory)

  if (error) {
    return <ErrorState description={error.message} onRetry={reload} />
  }

  const gridCols = compact
    ? 'grid-cols-1 md:grid-cols-2'
    : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'

  return (
    <div className="flex gap-6 min-h-0">
      <aside className="w-44 shrink-0">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-2">
          카테고리
        </div>
        <ul className="space-y-1">
          <li>
            <CategoryButton
              active={activeCategory === ALL}
              onClick={() => setActiveCategory(ALL)}
            >
              전체
              <span className="ml-auto text-xs text-muted-foreground">{list.length}</span>
            </CategoryButton>
          </li>
          {grouped.map((g) => (
            <li key={g.slug}>
              <CategoryButton
                active={activeCategory === g.slug}
                onClick={() => setActiveCategory(g.slug)}
              >
                {g.name}
                <span className="ml-auto text-xs text-muted-foreground">
                  {g.templates.length}
                </span>
              </CategoryButton>
            </li>
          ))}
        </ul>
      </aside>

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
          <SearchResults hits={searchHits} onPick={onPick} gridCols={gridCols} />
        ) : (
          <div className="space-y-8">
            {visibleGroups.length === 0 ? (
              <EmptyState
                title="이 부서에서 사용 가능한 템플릿이 없습니다"
                description="관리자가 새 템플릿을 만들거나, 글로벌 템플릿이 추가되면 여기에 표시됩니다."
              />
            ) : (
              visibleGroups.map((g) => (
                <CategorySection
                  key={g.slug}
                  group={g}
                  onPick={onPick}
                  gridCols={gridCols}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function CategoryButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
        active
          ? 'bg-primary/10 text-primary font-medium'
          : 'text-foreground/80 hover:bg-muted hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

function CategorySection({ group, onPick, gridCols }) {
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
          <TemplateCard key={`${t.template_id}-${t.version}`} template={t} onPick={onPick} />
        ))}
      </div>
    </section>
  )
}

function SearchResults({ hits, onPick, gridCols }) {
  if (!hits || hits.length === 0) {
    return (
      <EmptyState
        icon={Search}
        title="일치하는 템플릿이 없습니다"
        description="검색어를 다르게 시도하거나 좌측 카테고리에서 둘러보세요."
      />
    )
  }
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-3">검색 결과 {hits.length}건</div>
      <div className={cn('grid gap-4', gridCols)}>
        {hits.map((t) => (
          <TemplateCard key={`${t.template_id}-${t.version}`} template={t} onPick={onPick} />
        ))}
      </div>
    </div>
  )
}

function TemplateCard({ template, onPick }) {
  const sectionTitles = Object.values(template.schema?.properties ?? {})
    .map((p) => p?.title)
    .filter(Boolean)

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
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
          섹션 {sectionTitles.length}개
          {template.owner_workspace_slug == null && (
            <Badge variant="secondary" className="ml-2 text-[9px]">
              전사
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
