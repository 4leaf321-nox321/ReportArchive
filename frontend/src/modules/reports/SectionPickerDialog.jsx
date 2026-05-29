import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Search, Trash2, X } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { findItemInCategories } from './sections'

/**
 * Two-stage radial section picker.
 *
 *   stage 1 — 6 category circles arranged in a hex around a center
 *             title; each circle is colored by its category.
 *   stage 2 — the chosen category centers itself + glows, the other 5
 *             dim, and that category's items radiate outward as a fan
 *             of labeled pills. Clicking an item commits the choice
 *             and closes the dialog.
 *
 * Backdrop is dismissible (click outside / Esc). Already-set values
 * jump straight to stage 2 with the right category pre-selected.
 */
export function SectionPickerDialog({
  open,
  categories,
  currentSection,
  onPick,
  onClear,
  onClose,
}) {
  const [activeCategoryCode, setActiveCategoryCode] = useState(null)
  // Free-text query — case-insensitive substring match against each
  // item`s label / en / code. Matching items radiate with a glow ring
  // and pop scale; non-matching dim down. The first matching category
  // auto-opens so the user sees the hit without an extra click; Enter
  // commits the first matched item straight away (spotlight-style).
  const [query, setQuery] = useState('')
  // Stabilize the cats reference so the search useMemo + open-effect
  // deps don`t fire every render when `categories` is null/undefined.
  const cats = useMemo(() => categories ?? [], [categories])

  useEffect(() => {
    if (!open) return
    // Reset / pre-select on every open so reopening for a different
    // block doesn't keep the previous block's stage state.
    const hit = currentSection ? findItemInCategories(cats, currentSection) : null
    setActiveCategoryCode(hit?.category?.slug ?? null)
    setQuery('')
  }, [open, currentSection, cats])

  // Build the search result set whenever the query changes. Returns
  // `null` when no query — callers use that as the "no filtering"
  // sentinel so default rendering paths stay untouched. Otherwise a
  // {Set<itemCode>, firstItem, hasMatches} bundle.
  const search = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const matchedCodes = new Set()
    const matchedCategories = []
    let firstItem = null
    for (const cat of cats) {
      const localHits = []
      for (const it of cat.items ?? []) {
        const label = (it.label ?? '').toLowerCase()
        const en = (it.en ?? '').toLowerCase()
        const code = (it.code ?? '').toLowerCase()
        if (label.includes(q) || en.includes(q) || code.includes(q)) {
          matchedCodes.add(it.code)
          localHits.push(it)
          if (!firstItem) firstItem = { item: it, category: cat }
        }
      }
      if (localHits.length > 0) matchedCategories.push(cat.slug)
    }
    return {
      codes: matchedCodes,
      categorySlugs: new Set(matchedCategories),
      firstItem,
      hasMatches: matchedCodes.size > 0,
    }
  }, [query, cats])

  // Auto-activate the first category that contains a search hit so the
  // user lands on stage 2 with the item ring visible. Skipped when the
  // currently active category already contains a hit — that way typing
  // doesn`t bounce the user out of the category they`re already in.
  useEffect(() => {
    if (!open || !search?.hasMatches) return
    if (activeCategoryCode && search.categorySlugs.has(activeCategoryCode)) return
    setActiveCategoryCode(search.firstItem.category.slug)
    // We intentionally do NOT depend on `activeCategoryCode` here — the
    // check above already guards against unwanted bounces, and adding it
    // to deps would re-fire the effect every time the user clicks back
    // to stage 1 mid-search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, search])

  // Esc closes the whole picker; if a query is active, Esc clears it
  // first so the user can recover the unfiltered view without losing
  // the dialog.
  useEffect(() => {
    if (!open) return
    function handleKey(e) {
      if (e.key === 'Escape') {
        if (query) setQuery('')
        else onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose, query])

  if (!open) return null

  const activeCategory = activeCategoryCode
    ? cats.find((c) => c.slug === activeCategoryCode)
    : null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background/20 animate-in fade-in duration-150"
      onMouseDown={(e) => {
        // Only dismiss when the click hits the backdrop itself, not a
        // child element bubbling up.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="relative w-[min(880px,95vw)] h-[min(880px,95vh)] rounded-2xl border bg-card/60 backdrop-blur-md shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header — fixed up top, doesn't compete with the radial canvas. */}
        <div className="absolute inset-x-0 top-0 flex items-center gap-2 px-4 py-3 z-10">
          {activeCategory ? (
            <button
              type="button"
              onClick={() => setActiveCategoryCode(null)}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground rounded-md px-2 py-1 hover:bg-muted shrink-0"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              뒤로
            </button>
          ) : (
            <span className="text-xs text-muted-foreground font-medium shrink-0">
              단락 구분 선택
            </span>
          )}
          {/* 검색 입력 — 카테고리에 무관하게 모든 항목의 label / en /
              code 를 case-insensitive 부분일치로 매칭. 입력 시 첫 매칭
              카테고리가 자동으로 열리고, Enter 로 첫 매칭 항목 즉시 선택. */}
          <div className="relative flex-1 max-w-md mx-auto">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && search?.firstItem) {
                  onPick(search.firstItem.item.code)
                  onClose()
                }
              }}
              placeholder="검색 (예: 배경)"
              className="w-full h-7 pl-7 pr-7 text-xs rounded-md border bg-background/80 focus:outline-none focus:ring-2 focus:ring-primary/40 placeholder:text-muted-foreground"
              autoFocus
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
                aria-label="검색 지우기"
                tabIndex={-1}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {currentSection && (
              <button
                type="button"
                onClick={() => {
                  onClear?.()
                  onClose()
                }}
                className="inline-flex items-center gap-1.5 text-xs text-destructive hover:bg-destructive/10 rounded-md px-2 py-1"
              >
                <Trash2 className="h-3.5 w-3.5" />
                지우기
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted"
              aria-label="닫기"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Stage 1: ring of category circles around the center title. */}
        <CategoryWheel
          categories={cats}
          activeSlug={activeCategoryCode}
          search={search}
          onPick={setActiveCategoryCode}
        />

        {/* Stage 2 (overlay): items radiating from the active category. */}
        {activeCategory && (
          <ItemRadial
            categories={cats}
            category={activeCategory}
            currentItemCode={currentSection}
            search={search}
            onPick={(itemCode) => {
              onPick(itemCode)
              onClose()
            }}
          />
        )}

        {/* Empty-state hint when the admin has cleared the taxonomy. */}
        {cats.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            등록된 단락 구분이 없습니다. 관리자에서 추가하세요.
          </div>
        )}

        {/* Search miss — keep the radial visible (dimmed) so the user
            still sees the topology, but call out the empty result. */}
        {cats.length > 0 && search && !search.hasMatches && (
          <div className="absolute inset-x-0 bottom-12 flex justify-center pointer-events-none">
            <div className="rounded-md bg-background/90 border px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
              "{query}" 검색 결과 없음
            </div>
          </div>
        )}

        {/* Footer hint */}
        <div className="absolute inset-x-0 bottom-0 px-4 py-2 text-[10px] text-center text-muted-foreground/70">
          {search?.hasMatches
            ? `매칭 ${search.codes.size}건 · Enter 로 첫 항목 선택`
            : activeCategory
            ? '항목을 선택하면 자동으로 닫힙니다 · 뒤로 가서 다른 분류를 고를 수 있습니다'
            : '분류를 클릭하면 그 안의 항목이 펼쳐집니다'}
        </div>
      </div>
    </div>
  )
}

/** Wheel geometry — shared between the category ring and the item
 *  ring so they stay aligned. CENTER is the wheel's pivot in dialog-
 *  local pixels; tweak in one place if the dialog frame ever resizes. */
const WHEEL = {
  CENTER: 440,
  CAT_ORBIT: 235, // distance from center to each category circle's center
  ITEM_ORBIT: 120, // distance from an active category to its item ring
}

/** Categories are laid out evenly around a circle. With the seed 6
 *  categories this is the original hexagon (60° apart); admin-added
 *  categories distribute the available 360° among however many exist. */
function categoryAngleDeg(idx, total) {
  if (total <= 0) return -90
  return -90 + (idx * 360) / total
}

function categoryPos(idx, total) {
  const rad = (categoryAngleDeg(idx, total) * Math.PI) / 180
  return {
    x: WHEEL.CENTER + WHEEL.CAT_ORBIT * Math.cos(rad),
    y: WHEEL.CENTER + WHEEL.CAT_ORBIT * Math.sin(rad),
  }
}

/** Category circles on a regular polygon around the center. Inactive
 *  ones shrink hard in stage 2 so the active category's item ring can
 *  occupy the same visual real estate without crashing into its
 *  neighbors. */
function CategoryWheel({ categories, activeSlug, search, onPick }) {
  const total = categories.length
  return (
    <div className="absolute inset-0 pointer-events-none">
      <div className="relative w-full h-full">
        {categories.map((cat, i) => {
          const { x, y } = categoryPos(i, total)
          // Search dimming layers ON TOP of the stage-2 dimming: a
          // category gets dimmed if (a) another category is active, or
          // (b) a search is active and THIS category has no hits.
          const searchMiss = search && !search.categorySlugs.has(cat.slug)
          const dimmed = (activeSlug && activeSlug !== cat.slug) || searchMiss
          const active = activeSlug === cat.slug
          return (
            <button
              key={cat.slug}
              type="button"
              onClick={() => onPick(cat.slug)}
              className={cn(
                'pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2',
                'rounded-full flex flex-col items-center justify-center text-center',
                'border-2 shadow-md transition-all duration-300 ease-out',
                'hover:scale-110 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-card',
                // Stage 2: inactive categories shrink hard + fade out so
                // the item ring around the active one stays uncluttered.
                dimmed && 'opacity-20 scale-[0.55] blur-[1px]',
                active && 'scale-110 shadow-xl ring-4 ring-offset-2 ring-offset-card',
              )}
              style={{
                left: x,
                top: y,
                width: active ? 134 : 122,
                height: active ? 134 : 122,
                backgroundColor: `${cat.color}22`,
                borderColor: cat.color,
                color: cat.color,
                '--tw-ring-color': cat.color,
              }}
              aria-pressed={active}
            >
              <span
                className="h-3 w-3 rounded-full mb-1.5"
                style={{ backgroundColor: cat.color }}
              />
              <span className="text-[13px] font-semibold leading-tight whitespace-pre-line px-2 text-foreground/90">
                {(cat.name ?? '').replace(' 및 ', '\n및 ')}
              </span>
            </button>
          )
        })}

        {/* Center label — present in stage 1 only. */}
        {!activeSlug && (
          <div
            className="absolute -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none"
            style={{ left: WHEEL.CENTER, top: WHEEL.CENTER }}
          >
            <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
              section
            </div>
            <div className="text-lg font-semibold mt-1">단락 구분</div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Items form a concentric ring around the active category — they orbit
 *  the category's own center (not the wheel's center). Evenly spaced over
 *  360° starting from the top of the orbit; selection commits and closes. */
function ItemRadial({ categories, category, currentItemCode, search, onPick }) {
  const total = categories.length
  const catIdx = categories.findIndex((c) => c.slug === category.slug)
  const { x: cx, y: cy } = categoryPos(catIdx, total)
  const n = category.items.length
  // Step around a full circle. First item sits at the top of the orbit
  // (-90°) so the ring reads left-to-right, top-down naturally.
  const step = n > 0 ? 360 / n : 0
  return (
    <div className="absolute inset-0 pointer-events-none">
      {/* Faint guide ring so the concentric-circle metaphor reads even
          before the user mouses over an item. */}
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full pointer-events-none animate-in fade-in duration-300"
        style={{
          left: cx,
          top: cy,
          width: WHEEL.ITEM_ORBIT * 2,
          height: WHEEL.ITEM_ORBIT * 2,
          border: `1px dashed ${category.color}55`,
        }}
      />
      {category.items.map((item, i) => {
        const angle = -90 + i * step
        const rad = (angle * Math.PI) / 180
        const left = cx + WHEEL.ITEM_ORBIT * Math.cos(rad)
        const top = cy + WHEEL.ITEM_ORBIT * Math.sin(rad)
        const selected = currentItemCode === item.code
        // Search highlight: matched items pop with an extra ring +
        // scale boost; unmatched items in this category fade so the
        // matched ones are visually loud. `search == null` keeps the
        // pre-search rendering unchanged.
        const searchMatch = search ? search.codes.has(item.code) : null
        return (
          <button
            key={item.code}
            type="button"
            onClick={() => onPick(item.code)}
            className={cn(
              'pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2',
              'rounded-full px-2.5 py-1 text-[11px] font-medium',
              'border bg-card shadow-sm transition-all duration-200',
              'animate-in fade-in zoom-in-90',
              'hover:scale-110 hover:shadow-md focus:outline-none focus:ring-2',
              selected && 'ring-2 shadow-md scale-105',
              searchMatch === true && 'ring-4 shadow-lg scale-125 z-10',
              searchMatch === false && 'opacity-25 blur-[1px]',
            )}
            style={{
              left,
              top,
              borderColor: category.color,
              color: selected ? '#fff' : category.color,
              backgroundColor: selected ? category.color : undefined,
              '--tw-ring-color': category.color,
              // Subtle cascade so the items appear to fly out of the
              // category circle one after another instead of all at once.
              animationDelay: `${i * 25}ms`,
            }}
            title={item.en}
          >
            <span className="whitespace-nowrap">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}
