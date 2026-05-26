// ReportPhase — collaboration state enum (협업개선_설계.md §8.3).
// Phase 0 migration dropped the legacy ReportStatus (draft/in_progress/
// completed) and replaced it with this; drives the list page's 상태
// column + filter, dashboard 단계별 panel, and the detail page's
// PhaseChip. Order = drafting → reviewing → finalized.
export const PHASES = [
  { value: 'drafting',  label: '작성 중', variant: 'secondary' },
  { value: 'reviewing', label: '리뷰 중', variant: 'default'   },
  { value: 'finalized', label: '발행됨',  variant: 'outline'   },
]

export const PHASE_LABEL = Object.fromEntries(PHASES.map((p) => [p.value, p.label]))
export const PHASE_VARIANT = Object.fromEntries(PHASES.map((p) => [p.value, p.variant]))

/**
 * Build a (slug → display name) lookup from the API-fetched category list.
 * Falls back to the slug itself when the category was deleted but a template
 * still references it.
 */
export function makeCategoryNameLookup(categories) {
  const map = new Map((categories ?? []).map((c) => [c.slug, c.name]))
  return (slug) => map.get(slug) ?? slug
}
