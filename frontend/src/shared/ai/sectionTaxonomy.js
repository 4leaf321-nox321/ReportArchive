/**
 * Render the admin-managed 단락 구분 taxonomy as a plain-text block the
 * AI can read. `categories` is the same array `useSectionTaxonomy()`
 * surfaces — each entry has a name and an ordered `items` list. The
 * output groups items under their category and shows `code: label
 * (영문명: en)` per line so the AI must use the exact `code` string
 * (not the Korean label) when filling `block_sections`.
 */
export function renderSectionTaxonomy(categories) {
  const list = Array.isArray(categories) ? categories : []
  if (list.length === 0) {
    return '(아직 등록된 단락 구분이 없습니다. `block_sections` 는 `{}` 로 비워두세요.)'
  }
  return list
    .map((cat) => {
      const items = Array.isArray(cat.items) ? cat.items : []
      if (items.length === 0) {
        return `### ${cat.name} (slug=${cat.slug})\n  (등록된 항목 없음)`
      }
      const lines = items.map((it) => {
        const en = it.en ? `  (영문명: ${it.en})` : ''
        return `  - \`${it.code}\` : ${it.label}${en}`
      })
      return `### ${cat.name} (slug=${cat.slug})\n${lines.join('\n')}`
    })
    .join('\n\n')
}
