export const STATUS_LABEL = {
  draft: '작성 중',
  in_review: '검토 중',
  approved: '승인됨',
  archived: '보관',
}

export const STATUS_VARIANT = {
  draft: 'secondary',
  in_review: 'default',
  approved: 'outline',
  archived: 'outline',
}

/**
 * Build a (slug → display name) lookup from the API-fetched category list.
 * Falls back to the slug itself when the category was deleted but a template
 * still references it.
 */
export function makeCategoryNameLookup(categories) {
  const map = new Map((categories ?? []).map((c) => [c.slug, c.name]))
  return (slug) => map.get(slug) ?? slug
}
