import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, FileCode2, Search, Sparkles } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import { EmptyState } from '@/shared/components/EmptyState'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { PageHeader } from '@/shared/components/PageHeader'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listTemplates } from '@/shared/api/templates'
import { listTemplateCategories } from '@/shared/api/templateCategories'
import { cn } from '@/shared/lib/utils'

const ALL = '_all'

export default function ReportNewPage() {
  const { slug, workspace } = useWorkspace()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState(ALL)
  const { data: templates, loading, error, reload } = useAsync(() => listTemplates(), [slug])
  const { data: categories } = useAsync(() => listTemplateCategories(), [])

  const list = templates ?? []
  const trimmed = query.trim().toLowerCase()
  const searching = trimmed.length > 0

  const grouped = useMemo(() => {
    // Use the API-fetched category list to seed buckets in display order. Fall
    // back to a synthetic "misc" bucket for templates with categories that
    // were deleted (admin removed it from the registry but the template still
    // references the slug).
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

  function handlePick(template) {
    navigate(`/w/${slug}/reports/new/${template.template_id}/${template.version}`)
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="새 보고서 — 템플릿 선택"
        description={`${workspace?.name ?? ''}에 작성할 보고서의 양식을 고르세요. 양식은 JSON Schema로 정의되어 있어 AI가 섹션 단위로 작성·검증합니다.`}
        breadcrumbs={[
          { label: workspace?.name ?? '부서', to: `/w/${slug}` },
          { label: '보고서', to: `/w/${slug}/reports` },
          { label: '새 보고서' },
        ]}
      />

      {error ? (
        <ErrorState description={error.message} onRetry={reload} />
      ) : (
        <div className="flex gap-6 min-h-0">
          {/* 좌측: 카테고리 필터 */}
          <aside className="w-48 shrink-0">
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

          {/* 우측: 검색 + 카드 */}
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
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Skeleton className="h-48" />
                <Skeleton className="h-48" />
                <Skeleton className="h-48" />
              </div>
            ) : searching ? (
              <SearchResults hits={searchHits} onPick={handlePick} />
            ) : (
              <div className="space-y-8">
                {visibleGroups.length === 0 ? (
                  <EmptyState
                    title="이 부서에서 사용 가능한 템플릿이 없습니다"
                    description="관리자가 새 템플릿을 만들거나, 글로벌 템플릿이 추가되면 여기에 표시됩니다."
                  />
                ) : (
                  visibleGroups.map((g) => (
                    <CategorySection key={g.slug} group={g} onPick={handlePick} />
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}
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

function CategorySection({ group, onPick }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {group.name}
        </h2>
        <span className="text-xs text-muted-foreground">({group.templates.length})</span>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {group.templates.map((t) => (
          <TemplateCard key={`${t.template_id}-${t.version}`} template={t} onPick={onPick} />
        ))}
      </div>
    </section>
  )
}

function SearchResults({ hits, onPick }) {
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
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {hits.map((t) => (
          <TemplateCard key={`${t.template_id}-${t.version}`} template={t} onPick={onPick} />
        ))}
      </div>
    </div>
  )
}

function TemplateCard({ template, onPick }) {
  // Extract section titles from the JSON Schema's top-level object properties.
  // Each section is encoded as a top-level property whose value is an object schema.
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
