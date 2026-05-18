// Order matters for the dashboard's status panel and the in-report
// dropdown — kept here as the single source of truth.
export const STATUSES = [
  { value: 'draft',       label: '작성 중',   variant: 'secondary' },
  { value: 'in_progress', label: '진행 업무', variant: 'default'   },
  { value: 'completed',   label: '완료 업무', variant: 'outline'   },
]

export const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.value, s.label]))
export const STATUS_VARIANT = Object.fromEntries(STATUSES.map((s) => [s.value, s.variant]))

/**
 * Build a (slug → display name) lookup from the API-fetched category list.
 * Falls back to the slug itself when the category was deleted but a template
 * still references it.
 */
export function makeCategoryNameLookup(categories) {
  const map = new Map((categories ?? []).map((c) => [c.slug, c.name]))
  return (slug) => map.get(slug) ?? slug
}
