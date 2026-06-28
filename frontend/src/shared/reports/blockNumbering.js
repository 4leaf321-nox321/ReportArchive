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

/**
 * Hierarchical outline numbers ("1" / "1.1" / "1.1.1") for a SINGLE rich_text
 * widget's items, by their depth in order. Self-contained (no report context) —
 * used by the RichText widget render and by DOCX/PPTX export so all three agree.
 * Empty rows are skipped (not counted). A skipped ancestor level renders as 1
 * (so "1.1.1" not "1.0.1"). Returns an array aligned to `items` (empty rows '').
 */
export function outlineNumbers(items) {
  const out = new Array(Array.isArray(items) ? items.length : 0).fill('')
  if (!Array.isArray(items)) return out
  const counters = [0, 0, 0, 0, 0, 0]
  items.forEach((it, i) => {
    if ((it?.text ?? '').trim().length === 0) return
    const d = Math.min(Math.max(Number(it?.depth) || 0, 0), 5)
    counters[d] += 1
    for (let deeper = d + 1; deeper <= 5; deeper += 1) counters[deeper] = 0
    out[i] = counters
      .slice(0, d + 1)
      .map((c) => (c === 0 ? 1 : c))
      .join('.')
  })
  return out
}

/**
 * Build hierarchical section numbers for heading widgets ("1", "1.1", "1.1.1").
 *
 * Like cross-reference numbers, these are DERIVED from whole-report document
 * order at render time and never stored — adding/moving/removing a heading
 * re-numbers everything automatically. Numbering is continuous across pages
 * (the toggle is report-level).
 *
 * Counters are kept per heading level (1–3). A heading at level L bumps its own
 * counter and resets all deeper levels, so the number is the join of counters
 * [1..L]. Non-heading blocks are skipped (they don't affect the count).
 *
 * @param orderedBlocks - whole-report document order: [{ id, type, pageIndex, level }]
 * @returns Map<refKey, string>  e.g. "0::sec_1" → "1.2.1"  (heading blocks only)
 */
export function buildHeadingNumbers(orderedBlocks) {
  const map = new Map()
  if (!Array.isArray(orderedBlocks)) return map
  const counters = [0, 0, 0] // levels 1, 2, 3
  for (const b of orderedBlocks) {
    if (b.type !== 'heading') continue
    const lvl = Math.min(Math.max(Number(b.level) || 2, 1), 3)
    counters[lvl - 1] += 1
    for (let deeper = lvl; deeper < 3; deeper += 1) counters[deeper] = 0
    // Display 0 ancestors as 1 so a skipped level (e.g. H3 right under H1)
    // renders "2.1.1" not "2.0.1". Counters themselves keep the real count so
    // later headings at that level still number correctly.
    const number = counters
      .slice(0, lvl)
      .map((c) => (c === 0 ? 1 : c))
      .join('.')
    map.set(blockRefKey(b.pageIndex, b.id), number)
  }
  return map
}
