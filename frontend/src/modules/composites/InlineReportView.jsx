import { useMemo } from 'react'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { useAsync } from '@/shared/hooks/useAsync'
import { getReport } from '@/modules/reports/api'
import { getComposite } from '@/shared/api/composites'
import { getTemplateVersion } from '@/shared/api/templates'
import { getRenderer } from '@/modules/templates/widgets'
import {
  DEFAULT_REPORT_WIDTH_PX,
  DEFAULT_REPORT_GAP_PX,
} from '@/modules/reports/ReportSettingsDialog'
import { useSectionTaxonomy } from '@/shared/hooks/useSectionTaxonomy'
import {
  ReportStyleContext,
  useReportStyleValue,
} from '@/shared/reports/ReportStyleContext'

/**
 * Read-only inline render of a source report. Resolves the report by id,
 * fetches each page's template, then walks the page content block-by-block
 * and lets each widget's Editor render itself in readOnly mode.
 *
 * Intentionally flat: no per-page grid layout, no edit affordances. The
 * goal is "let me skim the source without leaving the composite page",
 * not "edit the source from here".
 *
 * Phase 5A — `snapshot` prop: when the parent composite is published
 * (recurring) it has a frozen `snapshot_content` blob shaped like a
 * report payload (title + pages + width/gap + ...). Passing it here
 * makes the renderer skip the live `getReport(id)` fetch and render
 * that frozen content instead, so the composite always reflects the
 * as-of-publish state even if the source report has been edited since.
 */
export function InlineReportView({ reportId, snapshot, exposeBlockIds = true }) {
  // Live fetch only when no snapshot is supplied. Snapshot-rendered
  // items don't need a network roundtrip — the frozen blob already has
  // everything the renderer needs.
  const { data: liveReport, loading, error } = useAsync(
    () =>
      snapshot || !reportId ? Promise.resolve(null) : getReport(reportId),
    [reportId, Boolean(snapshot)],
  )
  const report = snapshot ?? liveReport
  // ⚠ Hook — sits ABOVE the early returns below so call order stays stable
  // across loading vs loaded renders. `report` may be null on first paint;
  // useReportStyleValue handles undefined / null inputs by returning the
  // default-glyph value, so this is safe to call unconditionally.
  const styleValue = useReportStyleValue({
    depthGlyphs: [
      report?.page_rich_text_prefix_d0,
      report?.page_rich_text_prefix_d1,
      report?.page_rich_text_prefix_d2,
    ],
  })
  if (!snapshot && loading) return <Skeleton className="h-24" />
  if (!snapshot && error)
    return <div className="text-xs text-destructive">{error.message}</div>
  if (!report) return null
  const pages = Array.isArray(report.pages) && report.pages.length > 0
    ? report.pages
    : [{ template_id: report.template_id, template_version: report.template_version, content: report.content ?? {} }]
  // Per-report content width + widget gap — same constraints the report
  // detail page applies. Reports that pre-date these settings fall back
  // to the frontend defaults.
  const pageWidthPx = Number.isFinite(report.page_width_px)
    ? report.page_width_px
    : DEFAULT_REPORT_WIDTH_PX
  const pageGapPx = Number.isFinite(report.page_gap_px)
    ? report.page_gap_px
    : DEFAULT_REPORT_GAP_PX
  return (
    <ReportStyleContext.Provider value={styleValue}>
      <div className="space-y-4 mx-auto w-full" style={{ maxWidth: `${pageWidthPx}px` }}>
        {pages.map((p, idx) => (
          <InlinePage
            key={idx}
            page={p}
            index={idx}
            totalPages={pages.length}
            rowGapPx={pageGapPx}
            exposeBlockIds={exposeBlockIds}
          />
        ))}
      </div>
    </ReportStyleContext.Provider>
  )
}

function InlinePage({ page, index, totalPages, rowGapPx, exposeBlockIds = true }) {
  const { data: template, loading } = useAsync(
    () => getTemplateVersion(page.template_id, page.template_version),
    [page.template_id, page.template_version],
  )
  // Section taxonomy — admin-managed 단락 구분 codes resolved into the
  // colored header strip each non-heading block displays in view mode.
  const { itemByCode: sectionItemByCode } = useSectionTaxonomy()
  // Use the SAME merge the report detail page does for live editing:
  //   - template blocks + page.extra_blocks (per-report additions)
  //   - honor page.blocks_order
  //   - per-block props_overrides applied on top of template props
  // Skipping any of these (which the old implementation did) hides
  // significant amounts of report content from the composite view.
  const blocks = useMemo(
    () => combinedBlocks(template?.schema, page),
    [template, page],
  )
  // Group blocks by their saved `layout.row` so blocks that sit
  // side-by-side in the source report stay side-by-side here too.
  // Within each row, ordering follows `blocks` order (which already
  // honored blocks_order in combinedBlocks). We use a 12-col CSS grid
  // mirroring `REPORT_GRID_COLS` — col_span maps directly. Heights
  // are CONTENT-DRIVEN here (no fixed row_span like RGL) so auto-fit
  // blocks render with their full content even if the source's saved
  // row_span is stale.
  const rows = useMemo(() => byRow(blocks, page), [blocks, page])

  if (loading) return <Skeleton className="h-20" />
  if (!template) return null
  return (
    <div className="space-y-3">
      {totalPages > 1 && (
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
          페이지 {index + 1} · {page.name || template.name}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          rowGap: Number.isFinite(rowGapPx) ? `${rowGapPx}px` : undefined,
        }}
      >
        {rows.map(({ row, items }) => (
          <div key={row} className="grid grid-cols-12 gap-3">
            {items.map((it) => (
              <div
                key={it.block.id}
                // `id="block-<id>"` mirrors what BlockEditorCard attaches
                // in the live editor — exposes this widget's container
                // to the DOCX exporter's `convertVisualBlock` (which
                // does `getElementById('block-<id>')` for html2canvas
                // captures of chart/diagram widgets).
                //
                // Same id on multiple pages of a report — or across
                // composite items that share a template — could in
                // principle collide. The composite exporter scopes its
                // lookup to a per-item offscreen container so that's
                // OK; single-report path already had the same shape.
                // 분할 보기 우측 패널(exposeBlockIds=false)은 좌측 에디터와
                // 동시 마운트라, 같은 block id 가 있으면 에디터의 getElementById
                // ('block-…')가 우측 노드를 잡을 수 있다. 그 패널은 export 를 안
                // 하므로 id 를 떼서 충돌을 막는다.
                id={exposeBlockIds ? `block-${it.block.id}` : undefined}
                style={{ gridColumn: `span ${it.colSpan} / span ${it.colSpan}` }}
                className="min-w-0"
              >
                <BlockBody
                  block={it.block}
                  content={page.content?.[it.block.id]}
                  propsOverride={page.props_overrides?.[it.block.id] ?? null}
                  sectionCode={resolveBlockSection(page, it.block)}
                  sectionItemByCode={sectionItemByCode}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Render a single block's editor in read-only mode. Pulls the same
 *  merged-props pattern the live detail page uses so an overridden
 *  chart_type / extended columns / per-block style all flow through.
 *  When the block carries a 단락 구분 (section marker), prepends the
 *  same colored header strip the report detail page draws so the
 *  composite view matches the source visually. */
export function BlockBody({ block, content, propsOverride, sectionCode, sectionItemByCode }) {
  const renderer = getRenderer(block.type)
  if (!renderer?.Editor) return null
  const mergedProps = propsOverride
    ? { ...(block.props ?? {}), ...propsOverride }
    : (block.props ?? {})
  const Editor = renderer.Editor
  const sectionEntry = sectionCode ? sectionItemByCode?.[sectionCode] : null
  const sectionItem = sectionEntry?.item ?? null
  const sectionCategory = sectionEntry?.category ?? null
  // The detail page omits the header strip for heading blocks (no
  // card chrome to attach to) — match that here too.
  const showSectionHeader =
    sectionItem && sectionCategory && block.type !== 'heading'
  const body = (
    <Editor
      props={mergedProps}
      content={content}
      onChange={() => {}}
      readOnly
      // autoFit=true → content drives height. RGL row_span isn't
      // enforced here; the source report's saved row_span often
      // matches dynamic measurement, but using saved row_span as a
      // hard ceiling would clip charts/images that re-measured to a
      // larger size on the source. Letting content drive matches
      // what users see when they actually open the report.
      autoFit={true}
    />
  )
  if (!showSectionHeader) return body
  // Mirrors `viewModeSectionHeader` in ReportDetailPage — same height,
  // same tint math (color + alpha for bg / border), same typography.
  // The body sits below the strip with no rounded corners on its top
  // so the two read as one continuous card.
  return (
    <div
      data-report-widget-card="true"
      className="rounded-md border bg-card overflow-hidden"
      style={{ borderColor: `${sectionCategory.color}40` }}
    >
      <div
        // data-export-skip → matches the marker in ReportDetailPage's
        // viewModeSectionHeader so the composite DOCX exporter's
        // html2canvas pass drops this strip from the captured PNG.
        data-export-skip="section-header"
        className="flex items-center px-3 border-b"
        style={{
          height: 34,
          backgroundColor: `${sectionCategory.color}14`,
          color: sectionCategory.color,
          borderBottomColor: `${sectionCategory.color}40`,
        }}
        title={sectionItem.label}
      >
        <span className="text-[15px] font-semibold tracking-tight">
          {sectionItem.label}
        </span>
      </div>
      <div className="p-3">{body}</div>
    </div>
  )
}

/** Resolve a block's effective section code — page override beats
 *  template default. Same logic as ReportDetailPage's helper of the
 *  same name; duplicated here to keep InlineReportView self-contained
 *  (the helper isn't exported). */
export function resolveBlockSection(page, block) {
  if (!block) return null
  const overrides = page?.block_sections
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, block.id)) {
    const v = overrides[block.id]
    return typeof v === 'string' && v.length > 0 ? v : null
  }
  return typeof block.section === 'string' && block.section.length > 0
    ? block.section
    : null
}

/** Group blocks by their `layout.row` and clamp col_span to 1..12.
 *  Returns rows sorted ascending by row index so the visual order
 *  matches the source report. Within each row, blocks keep the order
 *  they came in (already honoring blocks_order). */
function byRow(blocks, page) {
  const groups = new Map()
  for (const b of blocks) {
    const layout = page?.layout_overrides?.[b.id] ?? b.layout ?? {}
    const row = Number.isFinite(layout.row) ? layout.row : 99
    const rawSpan = Number.isFinite(layout.col_span) ? layout.col_span : 12
    const colSpan = Math.max(1, Math.min(12, rawSpan))
    if (!groups.has(row)) groups.set(row, [])
    groups.get(row).push({ block: b, colSpan })
  }
  return Array.from(groups.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([row, items]) => ({ row, items }))
}

/** Composites embedded inside other composites: show a compact summary
 *  (description + the item titles) instead of fully recursing — full
 *  rendering of a nested composite tree would explode quickly. */
export function InlineCompositeView({ compositeId }) {
  const { data: composite, loading, error } = useAsync(
    () => (compositeId ? getComposite(compositeId) : Promise.resolve(null)),
    [compositeId],
  )
  if (loading) return <Skeleton className="h-24" />
  if (error) return <div className="text-xs text-destructive">{error.message}</div>
  if (!composite) return null
  return (
    <div className="space-y-3">
      {composite.description && (
        <div className="text-sm whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2">
          {composite.description}
        </div>
      )}
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
        포함된 안건 {composite.items.length}건
      </div>
      <ul className="text-sm divide-y border rounded-md">
        {composite.items.map((it) => (
          <li key={it.id} className="py-2 px-3 flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground shrink-0 w-12">
              {it.item_type === 'report' ? '보고서' : '종합'}
            </span>
            <span className="truncate">
              {it.item_type === 'report' ? it.ref_report?.title : it.ref_composite?.title}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function extractBlocks(schema) {
  const blocks = Array.isArray(schema?.blocks) ? schema.blocks : []
  return blocks.map((b) => ({
    id: b.id,
    type: b.type,
    props: b.props ?? {},
    layout: b.layout ?? null,
    section: b.section ?? null,
  }))
}

/** Mirror of ReportDetailPage's `combinedBlocks` — merges template
 *  schema blocks with the page's report-specific `extra_blocks`,
 *  honoring `blocks_order` when present. Without this, anything the
 *  user added via "위젯 추가" on the report side (not in the template)
 *  would silently disappear from the composite's inline view. */
export function combinedBlocks(schema, page) {
  const tplBlocks = extractBlocks(schema)
  const extras = (page?.extra_blocks ?? []).map((b) => ({
    id: b.id,
    type: b.type,
    props: b.props ?? {},
    layout: b.layout ?? null,
    section: b.section ?? null,
  }))
  const order = Array.isArray(page?.blocks_order) ? page.blocks_order : []
  if (order.length === 0) {
    return [...tplBlocks, ...extras]
  }
  const byId = new Map()
  for (const b of tplBlocks) byId.set(b.id, b)
  for (const b of extras) byId.set(b.id, b)
  const out = []
  const seen = new Set()
  for (const id of order) {
    if (seen.has(id)) continue
    const b = byId.get(id)
    if (b) {
      out.push(b)
      seen.add(id)
    }
  }
  // Fall back to EXTRA blocks not listed in `order` (defensive — keeps
  // newly-added widgets visible even if blocks_order wasn't updated
  // alongside an extra-block addition). Template blocks are intentionally
  // NOT resurrected here: when `order` is present it is the source of
  // truth for which template blocks render, and AI authoring deliberately
  // omits unfilled template blocks from it (routes._build_ai_page →
  // blocks_order = filled_tpl_ids + extras). Re-adding them would surface
  // empty rich_text blocks whose caption auto-fills to the template label
  // ("내용") as a stray title row — a divergence from ReportDetailPage,
  // which renders only `order` blocks. So mirror that exactly.
  for (const b of extras) {
    if (!seen.has(b.id)) {
      out.push(b)
      seen.add(b.id)
    }
  }
  return out
}
