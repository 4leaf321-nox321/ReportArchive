import { useMemo } from 'react'
import { Copy } from 'lucide-react'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { useAsync } from '@/shared/hooks/useAsync'
import { getReport } from '@/modules/reports/api'
import { getComposite } from '@/shared/api/composites'
import { getTemplateVersion } from '@/shared/api/templates'
import { getRenderer } from '@/modules/templates/widgets'
import { autoFitForBlock, fixedBlockHeightPx } from '@/shared/reports/reportLayout'
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
/** 블록 + 페이지에서 "효과 스냅샷"({type, props, content, layout, section})을
 *  만든다 — 위젯 복사/가져오기가 self-contained extra block 으로 붙일 수 있게.
 *  ReportDetailPage 의 클립보드 paste · ImportWidgetDialog 와 같은 shape. */
export function widgetSnapshot(page, block) {
  const propsOverride = page?.props_overrides?.[block.id] ?? null
  return {
    type: block.type,
    props: propsOverride
      ? { ...(block.props ?? {}), ...propsOverride }
      : { ...(block.props ?? {}) },
    content: page?.content?.[block.id] ?? null,
    layout: page?.layout_overrides?.[block.id] ?? block.layout ?? null,
    section: resolveBlockSection(page, block),
  }
}

// §7.4 위젯 delta — 위젯의 마지막 변경시각(block_updated_at[id])이 이전 회차의
// 동결 시각(baseline)보다 뒤면 "지난 회차 이후 변경". baseline/stamp 중 하나라도
// 없으면(=모름) 강조하지 않는다(legacy 행 false positive 0, §14.2).
function widgetChangedSince(stampIso, baselineIso) {
  if (!stampIso || !baselineIso) return false
  const s = Date.parse(stampIso)
  const b = Date.parse(baselineIso)
  if (Number.isNaN(s) || Number.isNaN(b)) return false
  return s > b
}

function deltaLabel(baselineIso) {
  const d = new Date(baselineIso)
  if (Number.isNaN(d.getTime())) return '변경됨'
  return `${d.getMonth() + 1}/${d.getDate()} 이후 변경`
}

// 버전 비교(분할) — 우측(과거 버전) 위젯의 강조. changed=앰버(내용 다름),
// removed=로즈(현재 편집본에서 삭제됨). added 는 우측엔 안 나타난다(버전엔 없던 것).
function compareRightHighlight(state) {
  if (state === 'removed')
    return {
      border: ' ring-2 ring-inset ring-rose-400 rounded-md p-1 bg-rose-50/60 dark:ring-rose-500/70 dark:bg-rose-950/30',
      label: '삭제',
      chipCls:
        'border-rose-400 bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
      title: '현재 편집본에서 삭제된 위젯',
    }
  if (state === 'changed')
    return {
      border: ' ring-2 ring-inset ring-amber-400 rounded-md p-1 bg-amber-50/60 dark:ring-amber-500/70 dark:bg-amber-950/30',
      label: '변경',
      chipCls:
        'border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
      title: '현재 편집본과 내용이 다름',
    }
  return null
}

export function InlineReportView({
  reportId,
  snapshot,
  exposeBlockIds = true,
  onCopyWidget = null,
  // 이전 회차에서 이 안건이 동결된 시각(CompositeItemRead.prev_snapshot_taken_at).
  // 위젯 delta 강조의 기준점. null 이면 강조 없음(첫 회차·미발행·theme).
  baselineTakenAt = null,
  // 버전 비교(분할 우측) — 좌(현재)와 다른/삭제된 위젯 강조. compareSide==='right'
  // 이고 compareDiff 가 있을 때만 동작(종합보고 delta 와 독립).
  compareDiff = null,
  compareSide = null,
  // 에디터(ReportDetailPage)와 동일한 컨테이너/글자 스케일로 렌더한다. 분할 보기
  // 좌(에디터)와 우(이 뷰)의 글자 크기·위젯 카드 chrome·blend 를 일치시키려는 용도.
  // 기본 false — 종합보고/버전미리보기/export 는 기존 렌더를 그대로 유지(회귀 방지).
  editorChrome = false,
}) {
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
      <div
        className={
          // 페이지 간 간격 — editorChrome 이면 에디터(.report-detail-content)의
          // space-y-8 에 맞춘다(기본은 종전 space-y-4).
          (editorChrome ? 'space-y-8' : 'space-y-4') +
          ' mx-auto w-full' +
          // 에디터와 동일하게, blend(컨테이너 경계 숨김) 보고서면 위젯 카드 chrome 을
          // 끄는 .report-blend-blocks 를 건다(자식 [data-report-widget-card] 대상).
          (editorChrome && report.page_blend_blocks === true
            ? ' report-blend-blocks'
            : '')
        }
        style={{ maxWidth: `${pageWidthPx}px` }}
      >
        {pages.map((p, idx) => (
          <InlinePage
            key={idx}
            page={p}
            index={idx}
            totalPages={pages.length}
            rowGapPx={pageGapPx}
            exposeBlockIds={exposeBlockIds}
            onCopyWidget={onCopyWidget}
            sourceReportId={report?.id ?? null}
            baselineTakenAt={baselineTakenAt}
            compareDiff={compareDiff}
            compareSide={compareSide}
            editorChrome={editorChrome}
          />
        ))}
      </div>
    </ReportStyleContext.Provider>
  )
}

function InlinePage({
  page,
  index,
  totalPages,
  rowGapPx,
  exposeBlockIds = true,
  onCopyWidget = null,
  sourceReportId = null,
  baselineTakenAt = null,
  compareDiff = null,
  compareSide = null,
  editorChrome = false,
}) {
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
            {items.map((it) => {
              // §7.4 — 이 위젯이 이전 회차 동결 이후 바뀌었나.
              const changed = widgetChangedSince(
                page.block_updated_at?.[it.block.id],
                baselineTakenAt,
              )
              // 강조 — 버전 비교(우측)면 좌·우 diff 결과(우선), 아니면 종합보고
              // 회차 delta. 둘은 같은 화면에서 동시에 쓰이지 않는다.
              const compareState =
                compareSide === 'right' && compareDiff
                  ? compareDiff?.[index]?.[it.block.id]
                  : null
              const hl = compareState
                ? compareRightHighlight(compareState)
                : changed
                  ? {
                      border: ' ring-2 ring-inset ring-amber-400 rounded-md p-1 bg-amber-50/60 dark:ring-amber-500/70 dark:bg-amber-950/30',
                      label: deltaLabel(baselineTakenAt),
                      chipCls:
                        'border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
                      title: '지난 회차 이후 변경된 위젯',
                    }
                  : null
              // 세로 크기 — editorChrome 이면 에디터처럼 비-auto_fit 위젯(차트·트리맵
              // 등)에 row_span 기반 고정 높이를 줘 에디터와 같은 높이로 렌더한다.
              // auto_fit 위젯은 content 로 높이를 몬다(에디터와 동일). 종합보고/export
              // (editorChrome=false)는 종전처럼 전부 content 높이.
              const layout =
                page?.layout_overrides?.[it.block.id] ?? it.block.layout ?? {}
              const blockAutoFit = editorChrome
                ? autoFitForBlock(it.block, layout)
                : true
              const fixedHeight =
                editorChrome && !blockAutoFit
                  ? fixedBlockHeightPx(layout.row_span, rowGapPx)
                  : null
              return (
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
                style={{
                  gridColumn: `span ${it.colSpan} / span ${it.colSpan}`,
                  // 비-auto_fit 위젯은 에디터와 같은 고정 픽셀 높이로(아래 BlockBody
                  // 카드가 h-full 로 채운다). auto_fit/일반은 height 미지정(content).
                  height: fixedHeight ? `${fixedHeight}px` : undefined,
                }}
                className={'min-w-0 relative group' + (hl ? hl.border : '')}
              >
                {/* 위젯 강조 — 종합보고 회차 delta(§7.4) 또는 버전 비교 결과.
                    좌측 보더 + 칩. export 에선 생략(data-export-skip). */}
                {hl && (
                  <span
                    data-export-skip="delta-indicator"
                    className={
                      'absolute -top-2 left-2 z-10 inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium shadow-sm ' +
                      hl.chipCls
                    }
                    title={hl.title || ''}
                  >
                    {hl.label}
                  </span>
                )}
                {/* 위젯 복사 — 분할 보기 우측(읽기전용) 패널에서 위젯을 복사해
                    좌측 편집창에 붙여넣기. onCopyWidget 이 있을 때만 노출. */}
                {onCopyWidget && getRenderer(it.block.type)?.Editor && (
                  <button
                    type="button"
                    onClick={() =>
                      onCopyWidget({
                        ...widgetSnapshot(page, it.block),
                        sourceReportId,
                      })
                    }
                    title="이 위젯을 복사 (편집 창에 붙여넣기)"
                    className="absolute right-1 top-1 z-10 inline-flex items-center gap-1 rounded-md border bg-background/95 px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover:opacity-100"
                  >
                    <Copy className="h-3 w-3" />
                    복사
                  </button>
                )}
                <BlockBody
                  block={it.block}
                  content={page.content?.[it.block.id]}
                  propsOverride={page.props_overrides?.[it.block.id] ?? null}
                  sectionCode={resolveBlockSection(page, it.block)}
                  sectionItemByCode={sectionItemByCode}
                  editorChrome={editorChrome}
                  autoFit={blockAutoFit}
                  fillHeight={Boolean(fixedHeight)}
                />
              </div>
              )
            })}
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
export function BlockBody({
  block,
  content,
  propsOverride,
  sectionCode,
  sectionItemByCode,
  // 에디터와 동일한 글자 스케일·카드 chrome·패딩으로 그릴지(분할 보기 좌우 일치용).
  // 기본 false → 기존 종합보고/export 렌더 유지.
  editorChrome = false,
  // 위젯 auto_fit 여부(에디터와 동일 판정). false = 고정 높이 위젯(차트·트리맵 등).
  autoFit = true,
  // 고정 높이(비-auto_fit)면 카드가 부모(고정 px) 높이를 채우도록 h-full 사슬을 건다.
  fillHeight = false,
}) {
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
  const editor = (
    <Editor
      props={mergedProps}
      content={content}
      onChange={() => {}}
      readOnly
      // autoFit: editorChrome 분할 보기에선 호출부가 에디터와 같은 판정을 넘긴다
      // (비-auto_fit 차트/트리맵은 false → 부모 고정 높이를 채움). 종합보고/export
      // (editorChrome=false)는 true(content 가 높이를 몬다) 그대로 유지.
      autoFit={autoFit}
    />
  )
  // editorChrome=true → 에디터(BlockEditorCard)와 같은 본문 글자 스케일을 위해
  // `.report-widget-body` 로 감싼다(index.css 의 1.3× 오버라이드 적용). 그 외엔
  // 기존 그대로(맨몸 Editor) — 종합보고/export 렌더에 영향 없음.
  const body = editorChrome ? (
    <div className={'report-widget-body' + (fillHeight ? ' h-full' : '')}>
      {editor}
    </div>
  ) : (
    editor
  )
  // 본문 패딩 — editorChrome 이면 에디터 view 모드 카드와 동일(px-6 pt-4 pb-4),
  // 아니면 기존 종합보고/export 패딩(p-3). 고정 높이면 flex-1 로 카드 안을 채운다.
  const bodyPad =
    (editorChrome ? 'px-6 pt-4 pb-4' : 'p-3') +
    (fillHeight ? ' flex-1 min-h-0' : '')
  // 카드 외곽 — 고정 높이 위젯이면 h-full flex-col 로 부모(고정 px) 높이를 채운다.
  const cardCls =
    (editorChrome
      ? 'rounded-lg border bg-card shadow-sm overflow-hidden'
      : 'rounded-md border bg-card overflow-hidden') +
    (fillHeight ? ' h-full flex flex-col' : '')

  // 헤딩은 에디터에서도 카드 chrome 이 없다(맨몸) — 동일하게.
  if (block.type === 'heading') return body

  if (showSectionHeader) {
    // Mirrors `viewModeSectionHeader` in ReportDetailPage — same height,
    // same tint math (color + alpha for bg / border), same typography.
    return (
      <div
        data-report-widget-card="true"
        className={cardCls}
        style={{ borderColor: `${sectionCategory.color}40` }}
      >
        <div
          // data-export-skip → matches the marker in ReportDetailPage's
          // viewModeSectionHeader so the composite DOCX exporter's
          // html2canvas pass drops this strip from the captured PNG.
          data-export-skip="section-header"
          className="flex items-center px-3 border-b shrink-0"
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
        <div className={bodyPad}>{body}</div>
      </div>
    )
  }

  // 단락 구분 없는 일반 위젯. editorChrome 이면 에디터처럼 카드(테두리·배경·그림자
  // ·패딩)로 감싼다 — blend 보고서면 부모의 .report-blend-blocks 가 이 chrome 을
  // 끈다(data-report-widget-card 마커). 그 외엔 기존처럼 맨몸(종합보고/export 불변).
  if (editorChrome) {
    return (
      <div data-report-widget-card="true" className={cardCls}>
        <div className={bodyPad}>{body}</div>
      </div>
    )
  }
  return body
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
