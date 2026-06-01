// Word (.docx) exporter for a single report.
//
// Each widget type gets a small converter that turns its content into
// docx primitives (Paragraph / Table / ImageRun). Text-shaped widgets
// (heading, rich_text, key_value, bulleted_list, table, attachment)
// are converted to editable Word text/tables. Visual widgets that
// don't have a clean text representation — chart, flowchart, milestone —
// are captured from the currently rendered DOM via html2canvas and
// embedded as PNG images. Caller is expected to flip the report into
// view-mode (no drag handles, no edit toolbars) before invoking this,
// so the captures don't include UI chrome.
//
// Block ordering follows the template's declared `blocks_order` /
// schema sequence, not the GridLayout row/col positions — the doc reads
// like a linear narrative, not a 2D layout.

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  LineRuleType,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import html2canvas from 'html2canvas'
// Reuse the project's authed axios client so /api/files requests carry
// the bearer token. Raw `fetch()` wouldn't see the access token without
// pulling auth helpers in, and the apiClient already handles refresh /
// 401 retries uniformly.
import { apiClient } from '@/shared/api/client'
// Post-process docx-js`s output to remove the always-empty `comments`
// part that triggers Word`s "복구하겠습니까?" recovery dialog on every
// open. See exportDocxStripOrphans.js for the full rationale.
import { stripOrphanDocxParts } from './exportDocxStripOrphans'

// docx `size` is in half-points (26 = 13pt). The user wants the whole
// document at 13pt 바탕체 so both constants resolve to the same value;
// titles/headings stay visually distinct via bold + heading levels +
// "[섹션] : 제목" labeling rather than via font-size hierarchy.
// Inline-formatting from rich_text (the user-picked size via the
// TipTap editor) still overrides BODY_SIZE on a per-run basis — that's
// an explicit choice and shouldn't be overridden by the document default.
export const TITLE_SIZE = 26 //  13pt
export const BODY_SIZE = 26 //   13pt

// Default line spacing multiplier applied to every paragraph in the
// document. docx-js encodes "multiple line spacing" in 240ths
// (LineRuleType.AUTO) — so 240 = 1.0x, 288 = 1.2x, 360 = 1.5x. Set on
// styles.default.document.paragraph.spacing so it cascades into table
// cells and headings too; per-Paragraph overrides still win when an
// explicit spacing is passed.
export const LINE_SPACING_AUTO_240THS = 288 // 1.2x

// Korean serif font for the document body. Set both as the Document
// default (styles.default.document.run.font) AND per-TextRun where
// possible — some Word builds ignore the default for east-asian text
// runs unless explicitly stamped, and explicit always wins anyway.
export const BODY_FONT = 'Batang'

// Page content width in pixels — corresponds roughly to standard A4
// portrait minus 2.5cm side margins (~660px at 96dpi). Single-column
// blocks size their visual capture against this; multi-column cells
// scale it down proportional to col_span/12 so the image fits in its
// cell instead of overflowing.
export const BODY_FULL_WIDTH_PX = 560

// Layout shorthand for "no borders anywhere" — applied to the
// per-row Table used for multi-column block layouts. Reads as a
// transparent column device in Word rather than a data table.
export const INVISIBLE_TABLE_BORDERS = {
  top:    { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right:  { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  insideVertical:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
}

// --- Public entrypoint ------------------------------------------------ //

/**
 * Export a single report to a downloadable .docx file.
 *
 * @param {object}   params
 * @param {object}   params.draft               in-memory report draft
 * @param {Map}      params.pageTemplateMap     pageIdx → template (already fetched)
 * @param {object}   params.sectionItemByCode   section taxonomy lookup
 * @param {Function} [params.onProgress]        progress callback fired at key
 *                                              moments. Receives a single
 *                                              `{ phase, current, total, label }`
 *                                              object — caller can render a
 *                                              spinner / progress bar.
 *                                              `phase` is one of:
 *                                              'start' | 'block' | 'packing' | 'done'.
 *                                              `current` / `total` are present
 *                                              only for 'block' so callers can
 *                                              render "N/M".
 */
export async function exportReportToDocx({
  draft,
  pageTemplateMap,
  sectionItemByCode,
  onProgress,
  signal,
}) {
  // Best-effort progress emit — wrap so a buggy callback doesn't crash
  // the export. Falls back to no-op when caller didn't pass one.
  const emit =
    typeof onProgress === 'function'
      ? (ev) => {
          try {
            onProgress(ev)
          } catch {
            /* swallow */
          }
        }
      : () => {}
  // Cancellation hook — caller wires the overlay`s 취소 button to an
  // AbortController and passes signal here. The per-block loop polls
  // this between captures, so the user gets near-instant feedback;
  // each html2canvas call is the slowest blocking step and pausing
  // before it bounds the wait to that single block.
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
  }
  throwIfAborted()

  // Per-report depth-별 glyph overrides for rich_text widgets — length 3
  // array `[d0, d1, d2]`. depth 2 글리프는 depth 2+ 모두에 사용된다 (=
  // 깊은 들여쓰기는 depth 2 값을 이어 쓴다). 각 칸이 null 이면 그 depth
  // 만 module 기본 (DEPTH_PREFIX[depth]) 으로 폴백.
  const depthGlyphs = [
    sanitizeDepthGlyph(draft?.page_rich_text_prefix_d0),
    sanitizeDepthGlyph(draft?.page_rich_text_prefix_d1),
    sanitizeDepthGlyph(draft?.page_rich_text_prefix_d2),
  ]

  // Count visual + content blocks upfront so the progress bar can show
  // a stable denominator. Heading/rich_text/etc. are fast so they go
  // by quickly, but visual widgets (html2canvas) dominate wall time.
  const pages = draft.pages ?? []
  let totalBlocks = 0
  for (const p of pages) {
    const tpl = lookupTemplate(pageTemplateMap, p)
    totalBlocks += combinedBlocks(tpl, p).length
  }
  emit({ phase: 'start', total: totalBlocks, label: '문서 준비 중...' })

  const children = []

  // Title block. Prefix `□ ` so the top-level 전체 과제명 carries its
  // dedicated marker (the depth-0 square `■` is reserved for body
  // outline rows in the RichText widget; `□` stays unique to the
  // report title).
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [
        new TextRun({
          text: `□ ${draft.title || '(제목 없음)'}`,
          size: TITLE_SIZE,
          font: BODY_FONT,
          // HeadingLevel.TITLE 의 default Word "Title" style 이 일부
          // 환경에서 굵기를 자동 적용 안 함 (특히 사용자 정의 default
          // run 을 덮어쓸 때). TextRun 레벨에서 명시해 보장.
          bold: true,
          // Word's TITLE / HEADING_x styles default to dark-blue text.
          // Force black on every heading-tier run so the export looks
          // like a plain manuscript instead of carrying Word's heading
          // palette into our document.
          color: '000000',
        }),
      ],
    }),
  )
  // (report_date 줄은 사용자 요청으로 제거 — 제목 바로 아래 빈 단락만
  //  남겨서 다음 위젯과 시각 간격 유지)
  children.push(emptyParagraph())

  // `pages` and `totalBlocks` were resolved above (used for the start
  // progress event). Reuse them so the block loop doesn't re-walk the
  // template list a second time.
  let processed = 0
  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx]
    const template = lookupTemplate(pageTemplateMap, page)
    const blocks = combinedBlocks(template, page)

    if (pages.length > 1) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          pageBreakBefore: pageIdx > 0,
          children: [
            new TextRun({
              text: page.name || `Page ${pageIdx + 1}`,
              size: TITLE_SIZE,
              color: '000000',
            }),
          ],
        }),
      )
    } else if (pageIdx > 0) {
      children.push(new Paragraph({ pageBreakBefore: true }))
    }

    // Group blocks by their layout row so multi-column web layouts
    // (e.g. 2 widgets side-by-side at 6 col_span each) survive into
    // Word as a docx Table row rather than stacking vertically. Within
    // a row, blocks keep their declaration / blocks_order order →
    // left-to-right mirrors the web rendering.
    const rowGroups = groupBlocksByRow(blocks, page)

    for (const rowItems of rowGroups) {
      // Compute total col_span actually used in this row. Anything
      // short of 12 → leftover slack we'll pad with an empty trailing
      // cell so the block(s) keep their proportional width (e.g. a
      // solo col_span=6 block lands at 50% instead of stretching to
      // 100%, matching the web's left-pack render).
      const usedCols = rowItems.reduce((s, it) => s + (it.layout.col_span || 0), 0)
      const slackCols = Math.max(0, 12 - usedCols)
      const isFullWidthSole = rowItems.length === 1 && slackCols === 0

      // Solo full-width block (col_span=12) → simple paragraph stream.
      // Most rows are this case (every text widget defaults to 12).
      // Skipping the Table wrapper keeps the docx smaller and avoids
      // an unnecessary nesting layer.
      if (isFullWidthSole) {
        throwIfAborted()
        const { block } = rowItems[0]
        processed += 1
        emit({
          phase: 'block',
          current: processed,
          total: totalBlocks,
          label: `위젯 변환 중 (${block.type})`,
        })
        const pieces = await renderBlockPieces({
          block,
          page,
          sectionItemByCode,
          maxImageWidthPx: BODY_FULL_WIDTH_PX,
          depthGlyphs,
        })
        for (const el of pieces) children.push(el)
        children.push(emptyParagraph())
        continue
      }

      // Otherwise → docx Table with one cell per block + (optional)
      // trailing empty cell to consume slack so widths stay
      // proportional. Borders all invisible so it reads as a column
      // layout, not a data grid. This branch covers:
      //   - N blocks summing to 12 (e.g. 6+6, 4+4+4) — pure multi-column
      //   - N blocks summing to <12 (e.g. solo 6, 8+2 with extra slack)
      //     → trailing pad cell takes the remainder, blocks stay at
      //     their proportional width like on the web
      const cells = []
      for (const { block, layout } of rowItems) {
        throwIfAborted()
        processed += 1
        emit({
          phase: 'block',
          current: processed,
          total: totalBlocks,
          label:
            rowItems.length > 1
              ? `위젯 변환 중 (${block.type}, ${rowItems.length}열)`
              : `위젯 변환 중 (${block.type}, ${layout.col_span}/12폭)`,
        })
        const cellWidthPx = Math.max(
          120,
          Math.floor((layout.col_span / 12) * BODY_FULL_WIDTH_PX),
        )
        const pieces = await renderBlockPieces({
          block,
          page,
          sectionItemByCode,
          maxImageWidthPx: cellWidthPx,
          depthGlyphs,
        })
        cells.push(
          new TableCell({
            children: pieces.length > 0 ? pieces : [emptyParagraph()],
            width: {
              size: Math.round((layout.col_span / 12) * 100),
              type: WidthType.PERCENTAGE,
            },
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
          }),
        )
      }
      // Trailing slack cell — empty, sized to whatever's left of the
      // grid. Mirrors the web's left-pack: blocks fill cols 0..usedCols-1
      // and the remainder stays blank on the right.
      if (slackCols > 0) {
        cells.push(
          new TableCell({
            children: [emptyParagraph()],
            width: {
              size: Math.round((slackCols / 12) * 100),
              type: WidthType.PERCENTAGE,
            },
            margins: { top: 80, bottom: 80, left: 0, right: 0 },
          }),
        )
      }
      children.push(
        new Table({
          rows: [new TableRow({ children: cells })],
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: INVISIBLE_TABLE_BORDERS,
        }),
      )
      children.push(emptyParagraph())
    }
  }

  emit({ phase: 'packing', label: 'Word 파일로 묶는 중...' })
  const doc = new Document({
    creator: 'ReportArchive',
    title: draft.title || '',
    // Document-wide defaults — every TextRun without an explicit font/
    // size inherits these. We picked 바탕(Batang) 13pt so the whole
    // export reads as one continuous Korean manuscript. Explicit
    // overrides on individual runs (e.g. user-picked inline TipTap
    // font sizes) still win on a per-run basis.
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: BODY_SIZE },
          paragraph: {
            spacing: {
              line: LINE_SPACING_AUTO_240THS,
              lineRule: LineRuleType.AUTO,
            },
          },
        },
      },
    },
    sections: [{ properties: {}, children }],
  })

  throwIfAborted()
  const blob = await stripOrphanDocxParts(await Packer.toBlob(doc))
  throwIfAborted()
  const filename = `${sanitizeFileName(draft.title || 'report')}-${new Date()
    .toISOString()
    .slice(0, 10)}.docx`
  triggerDownload(blob, filename)
  emit({ phase: 'done', label: '저장 완료' })
}

// "Long text" widgets — their body already carries the message, so the
// DOCX exporter skips the figure-style caption heading for them. Visual
// widgets (chart / image / diagram / ...) keep the caption since the
// rendered image otherwise reads as an unlabeled figure.
const LONG_TEXT_BLOCK_TYPES = new Set([
  'heading',
  'rich_text',
  'bulleted_list',
])

// --- Block dispatcher ------------------------------------------------- //

async function convertBlock(block, props, content, opts = {}) {
  // `opts.maxImageWidthPx` flows down to converters that emit images
  // (convertImage, convertVisualBlock) so multi-column cells size their
  // captures to fit the cell. Default = full body width.
  const maxImageWidthPx = opts.maxImageWidthPx ?? BODY_FULL_WIDTH_PX
  // `opts.scopeEl` scopes visual-block DOM lookup to a specific
  // container — null = document-wide (single-report export). The
  // composite exporter passes an offscreen container so the same
  // `block-<id>` doesn't collide with copies live in other places
  // (e.g. an already-expanded item in the composite detail page).
  const scopeEl = opts.scopeEl ?? null
  // `opts.depthGlyphs` — per-report rich_text glyph override array
  // (length 3, `[d0, d1, d2]`). null/missing → falls through to
  // module default DEPTH_PREFIX in convertRichText.
  const depthGlyphs = opts.depthGlyphs ?? null
  const out = []

  // NB: caption emission moved to `renderBlockPieces` — it composes a
  // single combined header line "[섹션] : 캡션" so the widget's two
  // metadata bits sit on one row instead of two separate bold lines.
  // Keeping it here would double-print.

  switch (block.type) {
    case 'heading':
      out.push(...convertHeading(props, content))
      break
    case 'rich_text':
      out.push(...convertRichText(content, depthGlyphs))
      break
    case 'bulleted_list':
      out.push(...convertBulletedList(content))
      break
    case 'key_value':
      out.push(...convertKeyValue(props, content))
      break
    case 'table':
      // 표/비교표/RACI 는 GUI 에서 사용자가 컬럼 폭·셀 정렬·텍스트 스타일을
      // 직접 조절하는데, 예전 native docx Table 경로는 그 조정을 거의 못
      // 가져갔음 (열 폭 무시·셀 내 줄바꿈 손실 등). 다른 시각 위젯과 같이
      // html2canvas 로 화면을 그대로 떠서 PNG 로 박는 방식으로 통일 — 표가
      // 세로로 길 수 있으니 height 상한은 가로폭의 8배까지 풀어 둠.
      out.push(
        ...(await convertVisualBlock(
          block.id,
          'table',
          maxImageWidthPx,
          scopeEl,
          maxImageWidthPx * 8,
        )),
      )
      break
    case 'image': {
      // Annotated single-image cells go through the html2canvas path
      // so the annotation SVG overlay bakes into the captured PNG.
      // Plain galleries (no marks) keep the raw-file path so the
      // exported image stays at its native resolution.
      const hasAnnotations =
        Array.isArray(content?.annotations) && content.annotations.length > 0
      if (hasAnnotations) {
        out.push(...(await convertVisualBlock(block.id, 'image', maxImageWidthPx, scopeEl)))
      } else {
        out.push(...(await convertImage(content, maxImageWidthPx)))
        // The raw-file path embeds the image at native resolution and
        // never captures the on-screen ※ note, so emit it as text here.
        // (The annotated path bakes the note into its html2canvas PNG.)
        out.push(...convertNote(content))
      }
      // Always echo annotation labels as plain text after the image
      // — DOCX search treats the image as opaque pixels otherwise.
      out.push(...convertAnnotationLabels(content?.annotations))
      break
    }
    case 'attachment':
      out.push(...convertAttachment(content))
      break
    // Visual widgets — captured via html2canvas screenshot of their DOM
    // node. Annotation labels (if any) are echoed as plain text after
    // so DOCX search + screen readers can still reach them — the PNG
    // is opaque pixels otherwise.
    //
    // Adding a new visual widget? Just append its type slug here. The
    // capture path is widget-agnostic; the only requirement is that
    // the renderer mounts under id `block-<id>` (every Editor in
    // /widgets/ does), and WebGL canvases need
    // `preserveDrawingBuffer: true` so html2canvas can read the pixels
    // (Cad3d / Scatter3D already set this; plotly's WebGL mode does too).
    case 'chart':
    case 'scatter':
    case 'scatter3d':
    case 'heatmap':
    case 'contour':
    case 'treemap':
    case 'packing':
    case 'tree':
    case 'network':
    case 'mind_map':
    case 'pie':
    case 'waffle':
    case 'box':
    case 'density':
    case 'radar':
    case 'equation':
    case 'flowchart':
    case 'milestone':
    case 'progress_bar':
    case 'raci_matrix':
    case 'cad_3d':
    case 'comparison':
    case 'quadrant':
    case 'sankey':
    case 'video':
    case 'html_embed': {
      // comparison / raci_matrix 도 표와 같은 사유 — GUI 에서 조절한 컬럼
      // 폭이 docx 에 안 실리고, 행 수가 늘면 세로로 길어진다. 캡처 height
      // 상한을 가로 폭의 8배까지 풀어 자연 비율을 보존.
      const tallVisual =
        block.type === 'comparison' || block.type === 'raci_matrix'
      const heightCap = tallVisual ? maxImageWidthPx * 8 : null
      out.push(
        ...(await convertVisualBlock(
          block.id,
          block.type,
          maxImageWidthPx,
          scopeEl,
          heightCap,
        )),
      )
      // Generic annotation echo — any widget whose content carries a
      // non-empty `annotations` array gets its label text appended.
      // For widgets without annotations the call is a no-op (the array
      // is empty / missing) so this is safe across all visual types.
      // scatter3d / cad_3d / video etc. typically have no 2-D
      // annotation surface; the array stays empty and nothing emits.
      if (Array.isArray(content?.annotations) && content.annotations.length > 0) {
        out.push(...convertAnnotationLabels(content.annotations))
      }
      break
    }
    default:
      // Truly unknown type (e.g. a custom widget added after this file
      // was last touched, or a stale block from a renamed widget). Keep
      // the placeholder so the export doesn't silently drop content.
      out.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `[지원하지 않는 위젯: ${block.type}]`,
              italics: true,
              color: '888888',
              size: BODY_SIZE,
            }),
          ],
        }),
      )
  }
  return out
}

// --- Converters ------------------------------------------------------- //

function convertHeading(props, content) {
  const text = content?.text ?? props?.default_text ?? ''
  if (!text) return []
  const level = clamp(Number(props?.level ?? 1), 1, 3)
  const headingLevel = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
  }[level]
  return [
    new Paragraph({
      heading: headingLevel,
      children: [new TextRun({ text, size: TITLE_SIZE, color: '000000' })],
    }),
  ]
}

// Depth glyphs mirror the RichText widget's display set. depth 0 is
// `■` (was `□` → `▶` → `■`); `□` stays free for the top-level 전체
// 과제명 marker elsewhere in the document.
const DEPTH_PREFIX = ['■', '-', '·', '·', '·', '·']
const RT_INDENT_TWIPS_PER_DEPTH = 360 // ~0.25in
// 모든 RichText 줄이 [섹션] : 제목 헤더 아래에 시각적으로 "tucked under"
// 보이도록 기본 들여쓰기를 더한다. depth 0 (■) 도 0 이 아니라 이 값
// 만큼 안쪽으로 들어가고, 깊은 depth 는 그 위에 360씩 더 들어감.
const RT_BASE_INDENT_TWIPS = 360 // ~0.25in

function convertRichText(content, depthGlyphs) {
  // The widget accepts two persisted shapes:
  //   - { items: [{ depth, text, html? }, ...] }  — canonical, what
  //     the TipTap editor writes back on every edit.
  //   - { markdown: "..." }                       — legacy / AI output.
  // The DOCX exporter used to only handle the first, silently dropping
  // any rich_text whose content was pasted in as `markdown` (typical
  // for AI-generated reports). Fall back to a line-by-line parse so
  // those paragraphs actually appear in the exported Word file.
  let items = Array.isArray(content?.items) ? content.items : []
  if (items.length === 0 && typeof content?.markdown === 'string') {
    items = markdownToItemsForExport(content.markdown)
  }
  if (items.length === 0) return []
  // Per-report depth-별 glyph override 적용. depth 2 글리프는 depth 2+
  // 모두에 사용. 각 칸이 null 이면 그 depth 만 module 기본으로 폴백.
  const glyphFor = (depth) => {
    const overrideIdx = Math.min(depth, 2)
    return depthGlyphs?.[overrideIdx] || DEPTH_PREFIX[depth] || '·'
  }
  return items.map((it) => {
    const depth = clamp(it?.depth ?? 0, 0, 5)
    const prefix = `${glyphFor(depth)} `
    const runs = htmlToTextRuns(it?.html, it?.text ?? '')
    runs.unshift(
      new TextRun({ text: prefix, color: '888888', size: BODY_SIZE }),
    )
    return new Paragraph({
      indent: {
        left:
          RT_BASE_INDENT_TWIPS + depth * RT_INDENT_TWIPS_PER_DEPTH,
      },
      children: runs,
    })
  })
}

/** Minimal markdown → outline parser for the legacy `content.markdown`
 *  shape. Each non-empty line becomes one item; depth is inferred from
 *  bullet prefix (■/□/▶/–/·/-) or leading whitespace. Mirrors the spirit
 *  of RichText.jsx's parseMarkdownToItems but doesn't pull the whole
 *  widget into the exporter bundle.
 *  `■` (current), `□`, and `▶` (legacy glyphs) all map to depth 0 for
 *  backward compat with reports authored before the prefix swap. */
function markdownToItemsForExport(md) {
  if (typeof md !== 'string' || !md.trim()) return []
  const PREFIX_DEPTH = { '■': 0, '□': 0, '▶': 0, '–': 1, '-': 1, '*': 1, '•': 1, '·': 2 }
  const out = []
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    const m = line.match(/^(\s*)(\S)\s+(.*)$/)
    if (m && PREFIX_DEPTH[m[2]] !== undefined) {
      out.push({ depth: PREFIX_DEPTH[m[2]], text: m[3] })
      continue
    }
    // No recognized marker → use indent (2-space step) for depth.
    const indent = (line.match(/^(\s*)/)?.[1] ?? '').length
    out.push({
      depth: Math.min(3, Math.floor(indent / 2)),
      text: line.trim(),
    })
  }
  return out
}

function convertBulletedList(content) {
  const items = Array.isArray(content?.items) ? content.items : []
  return items
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .map(
      (s) =>
        new Paragraph({
          bullet: { level: 0 },
          children: [new TextRun({ text: s, size: BODY_SIZE })],
        }),
    )
}

function convertKeyValue(props, content) {
  const items = Array.isArray(props?.items) ? props.items : []
  const data = content ?? {}
  const rows = []
  for (const item of items) {
    const value = formatKvValue(item, data[item.key])
    if (value === '' || value === null || value === undefined) continue
    rows.push(
      new TableRow({
        children: [
          new TableCell({
            width: { size: 30, type: WidthType.PERCENTAGE },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: item.label || item.key,
                    color: '555555',
                    size: BODY_SIZE,
                  }),
                ],
              }),
            ],
          }),
          new TableCell({
            width: { size: 70, type: WidthType.PERCENTAGE },
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: String(value), size: BODY_SIZE }),
                ],
              }),
            ],
          }),
        ],
      }),
    )
  }
  if (rows.length === 0) return []
  return [
    new Table({
      rows,
      width: { size: 100, type: WidthType.PERCENTAGE },
    }),
  ]
}

function convertTable(props, content) {
  const columns =
    (Array.isArray(content?.columns) && content.columns) ||
    (Array.isArray(props?.columns) && props.columns) ||
    []
  const rowsData = Array.isArray(content?.rows) ? content.rows : []
  if (columns.length === 0) return []

  const headerCells = columns.map(
    (c) =>
      new TableCell({
        children: [
          new Paragraph({
            children: [
              new TextRun({
                text: c.label || c.key,
                bold: true,
                size: BODY_SIZE,
              }),
            ],
          }),
        ],
      }),
  )
  const headerRow = new TableRow({ tableHeader: true, children: headerCells })

  const bodyRows = rowsData.map(
    (row) =>
      new TableRow({
        children: columns.map(
          (c) =>
            new TableCell({
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: row?.[c.key] == null ? '' : String(row[c.key]),
                      size: BODY_SIZE,
                    }),
                  ],
                }),
              ],
            }),
        ),
      }),
  )

  return [
    new Table({
      rows: [headerRow, ...bodyRows],
      width: { size: 100, type: WidthType.PERCENTAGE },
    }),
  ]
}

async function convertImage(content, maxWidthPx = BODY_FULL_WIDTH_PX) {
  const files = Array.isArray(content?.files) ? content.files : []
  const out = []
  // Cap image height proportional to width so 2-col cells don't blow
  // up vertical space. Same aspect-friendly ratio the old constants
  // used (500 wide × 380 tall ≈ 0.76).
  const maxHeightPx = Math.round(maxWidthPx * 0.76)
  for (const file of files) {
    if (!file?.file_id) continue
    try {
      const buf = await fetchAsArrayBuffer(
        `/api/files/${encodeURIComponent(file.file_id)}`,
      )
      const { width, height } = await readImageSize(buf)
      const fitted = fitInto(width, height, maxWidthPx, maxHeightPx)
      out.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              data: buf,
              transformation: { width: fitted.w, height: fitted.h },
            }),
          ],
        }),
      )
      if (file.caption) {
        out.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: file.caption,
                italics: true,
                color: '555555',
                size: BODY_SIZE,
              }),
            ],
          }),
        )
      }
    } catch (err) {
      out.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `[이미지 로드 실패: ${file.filename || file.file_id}]`,
              italics: true,
              color: '888888',
              size: BODY_SIZE,
            }),
          ],
        }),
      )
    }
  }
  return out
}

/** Emit annotation labels as a small "어노테이션" caption block so
 *  DOCX search + screen readers can find them — the visual marks are
 *  baked into the rendered PNG which is opaque to text indexing.
 *  Returns [] when there are no labeled annotations. */
function convertAnnotationLabels(annotations) {
  if (!Array.isArray(annotations) || annotations.length === 0) return []
  const labeled = annotations.filter((a) => {
    if (a?.hidden) return false
    const text = a?.label?.text
    return typeof text === 'string' && text.trim() !== ''
  })
  if (labeled.length === 0) return []
  const out = [
    new Paragraph({
      children: [
        new TextRun({
          text: '어노테이션',
          bold: true,
          size: BODY_SIZE,
          color: '555555',
        }),
      ],
    }),
  ]
  for (const a of labeled) {
    out.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `· ${a.label.text}`,
            size: BODY_SIZE,
            color: '555555',
          }),
        ],
      }),
    )
  }
  return out
}

/** Emit the ※ bottom note as a small muted paragraph. Used by the
 *  plain-image gallery path, which embeds raw files and so doesn't
 *  bake the on-screen note into a PNG the way html2canvas widgets do.
 *  Returns [] when there's no note. */
function convertNote(content) {
  const text = (content?.note ?? '').trim()
  if (!text) return []
  return [
    new Paragraph({
      children: [
        new TextRun({
          text: `※ ${text}`,
          size: BODY_SIZE,
          color: '888888',
        }),
      ],
    }),
  ]
}

function convertAttachment(content) {
  const files = Array.isArray(content?.files) ? content.files : []
  return files.map(
    (f) =>
      new Paragraph({
        children: [
          new TextRun({
            text: `📎 ${f?.filename || f?.file_id || ''}`,
            size: BODY_SIZE,
          }),
        ],
      }),
  )
}

// Visual widgets that don't have a clean text representation. We snapshot
// the currently rendered DOM (the report is in view-mode at this point)
// with html2canvas and embed the resulting PNG. The captured node has the
// `block-<id>` id set on it inside ReportDetailPage.
async function convertVisualBlock(
  blockId,
  blockType,
  maxWidthPx = BODY_FULL_WIDTH_PX,
  scopeEl = null,
  // 캡처 이미지 height 상한. 기본은 historical 4:3 (= maxWidth × 0.75) —
  // 차트류는 셀 비율에 맞춰 캔버스가 이미 그 안에 들어오므로 영향 없음.
  // 표/RACI 처럼 세로로 길 수 있는 위젯은 caller 가 더 큰 값으로 풀어서
  // 자연 비율을 보존하도록 해야 한다 (가로폭만 셀에 맞추고 세로는 행
  // 개수만큼 늘어남).
  maxHeightPx = null,
) {
  // `scopeEl` lets callers scope the DOM lookup to a specific container —
  // critical for composite exports where multiple report items (possibly
  // sharing template + block ids) are mounted offscreen at the same time
  // or in sequence. Falls back to document-wide getElementById so the
  // single-report path stays unchanged.
  const el = scopeEl
    ? scopeEl.querySelector(`[id="block-${blockId}"]`)
    : document.getElementById(`block-${blockId}`)
  if (!el) {
    return [
      new Paragraph({
        children: [
          new TextRun({
            text: `[${blockType} 캡처 실패: DOM 노드 없음]`,
            italics: true,
            color: '888888',
            size: BODY_SIZE,
          }),
        ],
      }),
    ]
  }
  try {
    const canvas = await html2canvas(el, {
      scale: 2,
      backgroundColor: '#ffffff',
      // Avoid logging and tainting for cross-origin resources we don't have.
      logging: false,
      useCORS: true,
      // Drop any element marked `data-export-skip` from the rendered
      // clone so it doesn't get baked into the PNG. Currently used by
      // the 단락 구분 header strip — the exporter emits that label as
      // a separate paragraph above the image, and the colored strip
      // would otherwise double-print inside the capture.
      ignoreElements: (node) =>
        node?.dataset?.exportSkip != null,
    })
    const blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/png'),
    )
    if (!blob) throw new Error('toBlob returned null')
    const buf = await blob.arrayBuffer()
    // Maintain ~0.75 aspect (560×420 historical default) but scale to
    // the caller-supplied width so cells in multi-column layouts get
    // a properly-sized capture rather than overflowing. Caller can pass
    // an explicit maxHeightPx (e.g. table / raci) to relax the height
    // cap when natural aspect is portrait.
    const effectiveMaxHeightPx =
      maxHeightPx != null && Number.isFinite(maxHeightPx)
        ? maxHeightPx
        : Math.round(maxWidthPx * 0.75)
    const fitted = fitInto(canvas.width, canvas.height, maxWidthPx, effectiveMaxHeightPx)
    return [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new ImageRun({
            data: buf,
            transformation: { width: fitted.w, height: fitted.h },
          }),
        ],
      }),
    ]
  } catch (err) {
    return [
      new Paragraph({
        children: [
          new TextRun({
            text: `[${blockType} 캡처 실패: ${err?.message ?? err}]`,
            italics: true,
            color: '888888',
            size: BODY_SIZE,
          }),
        ],
      }),
    ]
  }
}

// --- Inline mark → TextRun parser ------------------------------------ //

// Walks the row's `<p>...</p>` html (TipTap output) and produces docx
// TextRun objects preserving bold/italic/underline/strike + inline
// color and font-size from <span style="...">. Empty html falls back to
// the plain `text` argument so legacy rows without html still convert.
function htmlToTextRuns(html, fallbackText) {
  if (typeof html !== 'string' || html.length === 0) {
    return [new TextRun({ text: fallbackText || '', size: BODY_SIZE })]
  }
  if (typeof DOMParser === 'undefined') {
    return [new TextRun({ text: fallbackText || '', size: BODY_SIZE })]
  }
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const p = doc.body.firstElementChild
  if (!p) return [new TextRun({ text: fallbackText || '' })]
  const runs = []
  walkInline(
    p,
    {
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      color: null,
      sizeHalfPts: null,
    },
    runs,
  )
  return runs.length > 0 ? runs : [new TextRun({ text: fallbackText || '' })]
}

function walkInline(node, fmt, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3 /* TEXT */) {
      const text = child.nodeValue ?? ''
      if (text.length === 0) continue
      out.push(
        new TextRun({
          text,
          bold: fmt.bold || undefined,
          italics: fmt.italic || undefined,
          underline: fmt.underline ? {} : undefined,
          strike: fmt.strike || undefined,
          color: fmt.color || undefined,
          // Editor-picked size wins; otherwise fall back to the doc-
          // wide body size so the rich_text paragraph stays in lockstep
          // with everything else (instead of inheriting Word's
          // out-of-the-box 11pt default).
          size: fmt.sizeHalfPts || BODY_SIZE,
        }),
      )
    } else if (child.nodeType === 1 /* ELEMENT */) {
      const tag = child.tagName.toLowerCase()
      const next = { ...fmt }
      if (tag === 'strong' || tag === 'b') next.bold = true
      if (tag === 'em' || tag === 'i') next.italic = true
      if (tag === 'u') next.underline = true
      if (tag === 's' || tag === 'del' || tag === 'strike') next.strike = true
      if (tag === 'br') {
        out.push(new TextRun({ text: '', break: 1 }))
        continue
      }
      if (tag === 'span') {
        const style = child.getAttribute('style') || ''
        const cm = style.match(/(^|;)\s*color\s*:\s*([^;]+)/i)
        const fm = style.match(/(^|;)\s*font-size\s*:\s*([^;]+)/i)
        if (cm) next.color = normalizeColor(cm[2].trim())
        if (fm) next.sizeHalfPts = cssFontSizeToHalfPts(fm[2].trim())
      }
      walkInline(child, next, out)
    }
  }
}

// CSS color (`#rgb`, `#rrggbb`, `rgb(...)`, named) → docx hex without `#`.
// Returns null for values we can't reduce, so the run inherits the doc
// default color.
function normalizeColor(s) {
  if (!s) return null
  const m1 = s.match(/^#([0-9a-f]{3})$/i)
  if (m1) {
    const v = m1[1]
    return (v[0] + v[0] + v[1] + v[1] + v[2] + v[2]).toUpperCase()
  }
  const m2 = s.match(/^#([0-9a-f]{6})$/i)
  if (m2) return m2[1].toUpperCase()
  const m3 = s.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (m3) {
    return [m3[1], m3[2], m3[3]]
      .map((n) => Number(n).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  }
  return null
}

// docx `size` is in half-points (size: 24 = 12pt). Browser font-size is
// typically `px`. 1pt = 4/3 px, so px → half-pts = px * 1.5.
function cssFontSizeToHalfPts(s) {
  if (!s) return null
  const pxMatch = s.match(/^([\d.]+)\s*px$/i)
  if (pxMatch) return Math.round(Number(pxMatch[1]) * 1.5)
  const ptMatch = s.match(/^([\d.]+)\s*pt$/i)
  if (ptMatch) return Math.round(Number(ptMatch[1]) * 2)
  return null
}

// --- Block ordering / template helpers (mirrors ReportDetailPage) ----- //

export function lookupTemplate(pageTemplateMap, page) {
  if (!page || !pageTemplateMap) return null
  const key = `${page.template_id}@${page.template_version}`
  // `pageTemplateMap` is a Map keyed by `<template_id>@<version>`, whose
  // value is the template object itself (schema, name, etc.).
  return typeof pageTemplateMap.get === 'function'
    ? pageTemplateMap.get(key) ?? null
    : pageTemplateMap[key] ?? null
}

/** Resolve the effective grid layout for one block on this page.
 *  Falls back to `{row: 0, col_span: 12}` (full-width sole occupant)
 *  for blocks without a layout — older templates / extra blocks. */
export function effectiveLayout(block, page) {
  const override = page?.layout_overrides?.[block.id]
  const base = block?.layout
  const lay = override ?? base ?? {}
  return {
    row: Number.isFinite(lay.row) ? lay.row : 0,
    col_span: Number.isFinite(lay.col_span) ? lay.col_span : 12,
    row_span: Number.isFinite(lay.row_span) ? lay.row_span : 1,
  }
}

/** Group blocks by their grid row so the export can mirror multi-column
 *  web layouts as multi-cell docx Table rows. Returns an array of row
 *  groups (each group = array of `{block, layout}`), sorted by row
 *  ascending. Within a group, blocks keep their declaration order which
 *  matches left-to-right rendering on the web. */
export function groupBlocksByRow(blocks, page) {
  const byRow = new Map()
  for (const block of blocks) {
    const layout = effectiveLayout(block, page)
    if (!byRow.has(layout.row)) byRow.set(layout.row, [])
    byRow.get(layout.row).push({ block, layout })
  }
  return [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, items]) => items)
}

/** Render one block (caption heading + body) into a flat array of docx
 *  primitives. Pulled out as a helper because both the single-column
 *  path and the multi-column cell path need the same emission logic.
 *  `maxImageWidthPx` flows into visual / image converters so cell-bound
 *  widgets don't overflow their column.
 *
 *  Header shape depends on widget type:
 *    - LONG_TEXT_BLOCK_TYPES (rich_text, heading, bulleted_list) →
 *      combined "[단락구분] : 제목" Heading 3 at full title size, so
 *      the long-form section retains its outline marker.
 *    - everything else → caption-only Heading 3 at 10pt, since the
 *      figure itself carries the visual weight and a smaller title
 *      reads more like a figure caption.
 *  `sectionItemByCode` resolves the 단락 구분 label for long-text
 *  widgets; non-long-text widgets ignore it. */
export async function renderBlockPieces({
  block,
  page,
  sectionItemByCode,
  maxImageWidthPx,
  // Optional offscreen container to scope visual-block DOM lookup to.
  // Used by the composite exporter when each item's report is mounted
  // off-screen for capture — keeps `block-<id>` collisions in check.
  scopeEl,
  // Per-report depth-별 glyph overrides for rich_text — length-3 array
  // `[d0, d1, d2]`. depth 2 글리프는 depth 2+ 모두에 사용된다. 각 칸이
  // null 이면 그 depth 만 module 기본 DEPTH_PREFIX[depth] 로 폴백.
  depthGlyphs,
}) {
  const content = page.content?.[block.id] ?? {}
  const propsOverride = page.props_overrides?.[block.id] ?? null
  const effectiveProps = mergePropsOverride(block.props, propsOverride)
  const sectionCode = page.block_sections?.[block.id]
  const sectionEntry = sectionCode
    ? sectionItemByCode?.[sectionCode]
    : null
  const sectionLabel =
    typeof sectionEntry?.item?.label === 'string'
      ? sectionEntry.item.label.trim()
      : ''

  const out = []
  // Caption value mirrors what CaptionInput shows on screen:
  //   1. content.caption (writer-typed) wins
  //   2. effectiveProps.label (template default) is the fallback so a
  //      chart whose title is still the template default still gets a
  //      heading in the DOCX (otherwise it'd live only inside the PNG)
  //   3. content.caption_skip_autofill === true means the writer
  //      explicitly hid the title — skip the heading entirely
  const captionSkipped = content?.caption_skip_autofill === true
  const writerCaption =
    typeof content?.caption === 'string' ? content.caption.trim() : ''
  const templateLabel =
    typeof effectiveProps?.label === 'string'
      ? effectiveProps.label.trim()
      : ''
  const caption = captionSkipped ? '' : writerCaption || templateLabel
  const isLongTextWidget = LONG_TEXT_BLOCK_TYPES.has(block.type)

  if (isLongTextWidget) {
    // Long-text widgets retain the combined "[단락구분] : 제목" header
    // at full title size so the outline / TOC keeps its prose-section
    // anchors. Either piece is omitted when absent; if neither exists,
    // no header at all.
    let headerText = ''
    if (sectionLabel && caption) headerText = `[${sectionLabel}] : ${caption}`
    else if (sectionLabel) headerText = `[${sectionLabel}]`
    else if (caption) headerText = caption
    if (headerText) {
      out.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          children: [
            new TextRun({
              text: headerText,
              bold: true,
              size: TITLE_SIZE,
              color: '000000',
            }),
          ],
        }),
      )
    }
  } else if (caption) {
    // Non-long-text widgets: just the caption at 10pt (20 half-points)
    // so it reads as a figure caption rather than an outline heading.
    // Wrapped in `< >` to visually mark it as a figure / object label
    // and distinguish it from inline prose. Still a Heading 3 paragraph
    // so Word's navigation pane can jump to it.
    out.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_3,
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: `<${caption}>`,
            bold: true,
            size: 20,
            color: '000000',
          }),
        ],
      }),
    )
  }
  try {
    const els = await convertBlock(block, effectiveProps, content, {
      maxImageWidthPx,
      scopeEl,
      depthGlyphs,
    })
    for (const el of els) out.push(el)
  } catch (err) {
    console.warn('[docx] block convert failed', block.id, err)
    out.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `[${block.type} 변환 실패: ${err?.message ?? err}]`,
            italics: true,
            color: '888888',
            size: BODY_SIZE,
          }),
        ],
      }),
    )
  }
  return out
}


export function combinedBlocks(template, page) {
  const tplBlocks = extractTemplateBlocks(template?.schema)
  const extras = (page?.extra_blocks ?? []).map((b) => ({
    id: b.id,
    type: b.type,
    props: b.props ?? {},
    layout: b.layout,
    source: 'extra',
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
  return out
}

function extractTemplateBlocks(schema) {
  const blocks = Array.isArray(schema?.blocks) ? schema.blocks : []
  return blocks.map((b) => ({
    id: b.id,
    type: b.type,
    props: b.props ?? {},
    layout: b.layout,
    source: 'template',
  }))
}

// Per-block visual-style overrides (text_style, depth_styles, ...) merge
// onto the template's props. We only need the keys that affect actual
// content shape — visual style isn't carried into the docx output.
function mergePropsOverride(props, override) {
  if (!override) return props
  return { ...(props ?? {}), ...override }
}

// --- Misc helpers ---------------------------------------------------- //

export function emptyParagraph() {
  return new Paragraph({ children: [new TextRun({ text: '' })] })
}

/** Per-report depth glyph 입력값을 화면/문서에 쓰일 형태로 정규화. string
 *  non-empty 면 trim, 그 외(null/undefined/whitespace) 면 null 반환 — null
 *  은 호출부에서 module 기본 글리프로 폴백한다. */
function sanitizeDepthGlyph(v) {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n | 0))
}

export { sanitizeDepthGlyph }

export function sanitizeFileName(name) {
  return (
    String(name || '')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .trim()
      .slice(0, 80) || 'report'
  )
}

export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoke 를 즉시 하면 일부 브라우저(특히 Chromium)에서 다운로드 fetch
  // 가 비동기로 실제 blob 을 읽기 전에 URL 이 사라져 콘솔에 GET blob:...
  // net::ERR_FILE_NOT_FOUND 가 찍힌다. 다음 이벤트 루프 + 충분한 여유
  // (60s) 를 두고 정리. blob 자체는 a.click() 가 시작시킨 download 가
  // 끝나면 브라우저가 알아서 메모리에서 풀어준다.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

async function fetchAsArrayBuffer(url) {
  const res = await apiClient.get(url, { responseType: 'arraybuffer' })
  return res.data
}

function readImageSize(arrayBuffer) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([arrayBuffer])
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth || 1
      const h = img.naturalHeight || 1
      URL.revokeObjectURL(url)
      resolve({ width: w, height: h })
    }
    img.onerror = (e) => {
      URL.revokeObjectURL(url)
      reject(e)
    }
    img.src = url
  })
}

// Scale (w, h) into the (maxW, maxH) bounding box, preserving aspect.
function fitInto(w, h, maxW, maxH) {
  const ratio = Math.min(maxW / w, maxH / h, 1)
  return { w: Math.round(w * ratio), h: Math.round(h * ratio) }
}

// Mirror of KeyValue.formatKvValue — keep in sync with the widget.
function formatKvValue(item, raw) {
  if (raw == null) return ''
  if (item?.type === 'select' && Array.isArray(item.options)) {
    const opt = item.options.find((o) => o.value === raw)
    if (opt) return opt.label || opt.value
  }
  if (Array.isArray(raw)) return raw.join(', ')
  return raw
}
