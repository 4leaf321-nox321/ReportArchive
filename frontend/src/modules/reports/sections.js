/**
 * Pure helpers for the "단락 구분" (section marker) taxonomy.
 *
 * The taxonomy itself is admin-managed and lives in the DB — fetch it
 * with `useSectionTaxonomy()`. These helpers operate on whatever
 * categories array the hook returns, so they keep working when admins
 * add / remove / rename items live.
 *
 * Item codes are stored on each report block in
 * `pages[*].block_sections[block_id]`. Codes are unique across the
 * whole taxonomy, so a single string identifies item + category.
 */

/** Resolve an item code → { item, category } via a flat scan. Callers
 *  with a precomputed `itemByCode` map (the hook builds one) should
 *  use that instead; this is the fallback when only the raw `categories`
 *  array is available.
 *  Returns null when the code is unknown (orphaned tag from a deleted
 *  item / category — UI treats these as "no section"). */
export function findItemInCategories(categories, code) {
  if (!code) return null
  for (const cat of categories ?? []) {
    for (const item of cat.items ?? []) {
      if (item.code === code) return { item, category: cat }
    }
  }
  return null
}

/** Convenience accessors that the report-side render helpers reach for. */
export function getSectionItem(itemByCode, code) {
  if (!code || !itemByCode) return null
  return itemByCode[code]?.item ?? null
}

export function getSectionCategory(itemByCode, code) {
  if (!code || !itemByCode) return null
  return itemByCode[code]?.category ?? null
}
