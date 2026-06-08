// Cross-reference numbering for report blocks ("그림 3", "표 2").
//
// Numbers are DERIVED from whole-report document order at render time and never
// stored — so reordering, inserting, or deleting blocks re-numbers everything
// automatically and any `#` reference in the body resolves to the current
// number. References are stored against the stable block id (the object), not
// the number.
//
// The category of each widget type comes from the backend catalog
// (descriptor.ref_category — the single source of truth). A widget with a null
// category is not referenceable (the prose body itself, section titles).

// Block ids are only unique WITHIN a page (templates reuse ids like "table_1"
// across pages), so the whole-report index is keyed by (pageIndex, blockId) —
// the same composite identity the comment anchors use. References store both.
export function blockRefKey(pageIndex, blockId) {
  return `${pageIndex}::${blockId}`
}

/** Widget type → reference category key (or null), per the backend catalog. */
export function refCategoryOf(catalog, type) {
  return catalog?.byType?.[type]?.ref_category ?? null
}

/** Category key → human label ("figure" → "그림"). Falls back to the key. */
export function categoryLabel(catalog, key) {
  const found = (catalog?.ref_categories ?? []).find((c) => c.key === key)
  return found?.label ?? key
}

/**
 * Build the block reference index.
 *
 * @param orderedBlocks - whole-report document order:
 *        [{ id, type, caption, pageIndex }]
 * @param catalog - widget catalog ({ byType, ref_categories }).
 * @returns Map<refKey, { key, id, type, category, n, label, caption, pageIndex }>
 *          keyed by blockRefKey(pageIndex, id); referenceable blocks only.
 */
export function buildBlockIndex(orderedBlocks, catalog) {
  const counters = {}
  const index = new Map()
  if (!Array.isArray(orderedBlocks)) return index
  for (const b of orderedBlocks) {
    const category = refCategoryOf(catalog, b.type)
    if (!category) continue
    counters[category] = (counters[category] ?? 0) + 1
    const n = counters[category]
    const key = blockRefKey(b.pageIndex, b.id)
    index.set(key, {
      key,
      id: b.id,
      type: b.type,
      category,
      n,
      label: `${categoryLabel(catalog, category)} ${n}`,
      caption: b.caption ?? '',
      pageIndex: b.pageIndex,
    })
  }
  return index
}

/**
 * Flat, ordered list for the `#` picker — referenceable blocks with their
 * current label + caption. Derived from the index in document order.
 */
export function referenceableBlockList(index) {
  return Array.from(index.values())
}
