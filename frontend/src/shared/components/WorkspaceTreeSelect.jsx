import { Fragment, useMemo, useState } from 'react'
import { Building2, ChevronRight, ChevronDown, Search } from 'lucide-react'
import { Input } from '@/shared/components/ui/input'

/** 조직 워크스페이스 트리 다중 선택 — 체크박스 + 펼침/접기 + 검색.
 *  "조직 게시판에 게시"·"템플릿 공유"와 동일한 트리 UX 를 재사용한다.
 *
 *  props:
 *    orgWorkspaces : org 워크스페이스 배열 ({ slug, name, parent_slug, color }).
 *    selected      : Set<slug> (또는 has() 가능한 객체) — 체크 상태.
 *    onToggle(slug): 체크 토글 콜백.
 *    autoExpandSlugs : 초기 펼침 seed — 이 slug 들의 조상을 펼친 채 시작.
 *    searchPlaceholder / maxHeightClass : 선택 커스터마이즈.
 */
export function WorkspaceTreeSelect({
  orgWorkspaces,
  selected,
  onToggle,
  autoExpandSlugs,
  searchPlaceholder = '조직명 / slug 검색 (비우면 트리 보기)',
  maxHeightClass = 'max-h-[55vh]',
}) {
  const orgs = useMemo(() => orgWorkspaces ?? [], [orgWorkspaces])

  const { roots, childrenOf, bySlug } = useMemo(() => {
    const orgSet = new Set(orgs.map((w) => w.slug))
    const bySlug = new Map(orgs.map((w) => [w.slug, w]))
    const childrenOf = new Map()
    const roots = []
    const byName = (a, b) => a.name.localeCompare(b.name)
    for (const w of [...orgs].sort(byName)) {
      if (w.parent_slug && orgSet.has(w.parent_slug)) {
        if (!childrenOf.has(w.parent_slug)) childrenOf.set(w.parent_slug, [])
        childrenOf.get(w.parent_slug).push(w)
      } else {
        roots.push(w)
      }
    }
    return { roots, childrenOf, bySlug }
  }, [orgs])

  function pathLabel(slug) {
    const out = []
    let cur = bySlug.get(slug)?.parent_slug
    while (cur) {
      out.unshift(bySlug.get(cur)?.name ?? cur)
      cur = bySlug.get(cur)?.parent_slug
    }
    return out.join(' / ')
  }

  const [expanded, setExpanded] = useState(() => {
    // autoExpandSlugs 의 조상들을 펼친 채 시작 (선택된 항목이 바로 보이게).
    const parentBy = new Map(orgs.map((w) => [w.slug, w.parent_slug]))
    const exp = new Set()
    for (const s of autoExpandSlugs ?? []) {
      let cur = parentBy.get(s)
      while (cur) {
        exp.add(cur)
        cur = parentBy.get(cur)
      }
    }
    return exp
  })
  const [query, setQuery] = useState('')

  function toggleExpand(slug) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }

  const trimmed = query.trim().toLowerCase()
  const searching = trimmed.length > 0
  const searchResults = orgs
    .filter(
      (w) =>
        w.name.toLowerCase().includes(trimmed) ||
        w.slug.toLowerCase().includes(trimmed),
    )
    .sort((a, b) => a.name.localeCompare(b.name))

  function renderNode(w, depth) {
    const kids = childrenOf.get(w.slug) ?? []
    return (
      <Fragment key={w.slug}>
        <TreeRow
          ws={w}
          depth={depth}
          isExpanded={expanded.has(w.slug)}
          checked={selected.has(w.slug)}
          onToggleSelect={() => onToggle(w.slug)}
          onToggleExpand={kids.length > 0 ? () => toggleExpand(w.slug) : null}
        />
        {kids.length > 0 &&
          expanded.has(w.slug) &&
          kids.map((k) => renderNode(k, depth + 1))}
      </Fragment>
    )
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder}
          className="h-8 pl-8 text-sm"
        />
      </div>
      <div className={`${maxHeightClass} space-y-0.5 overflow-y-auto`}>
        {searching ? (
          searchResults.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              매칭되는 조직이 없습니다.
            </p>
          ) : (
            searchResults.map((w) => (
              <TreeRow
                key={w.slug}
                ws={w}
                depth={0}
                isExpanded={false}
                onToggleExpand={null}
                pathLabel={pathLabel(w.slug)}
                checked={selected.has(w.slug)}
                onToggleSelect={() => onToggle(w.slug)}
              />
            ))
          )
        ) : roots.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            부서가 없습니다.
          </p>
        ) : (
          roots.map((w) => renderNode(w, 0))
        )}
      </div>
    </div>
  )
}

function TreeRow({
  ws,
  depth,
  isExpanded,
  checked,
  onToggleSelect,
  onToggleExpand,
  pathLabel,
}) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-md px-1 py-1 hover:bg-muted/40"
      style={{ marginLeft: depth * 16 }}
    >
      {onToggleExpand ? (
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-muted"
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
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggleSelect}
          className="h-4 w-4 shrink-0"
        />
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: ws.color || '#64748b' }}
        />
        <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{ws.name}</span>
          {pathLabel && (
            <span className="block truncate text-[10px] text-muted-foreground">
              {pathLabel}
            </span>
          )}
        </span>
      </label>
    </div>
  )
}
