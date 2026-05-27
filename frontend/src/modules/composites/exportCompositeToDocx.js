// Composite report (.docx) exporter.
//
// Each composite item that references a report gets rendered as a
// section: "[N] {item title}" heading + the report's full content
// (text widgets converted directly; visual widgets captured via
// html2canvas against an offscreen InlineReportView mount).
//
// Layout option:
//   - 'portrait-1col'  → A4 portrait, single column. Items stack
//                        top-to-bottom in their saved order.
//   - 'landscape-2col' → A4 landscape, items split by per-item
//                        `display_column` (1=left, 2=right). Both
//                        columns are stacked inside a single
//                        invisible Table row — same pattern the
//                        report exporter uses for widget-row 2-col
//                        layout, just at the item level.

import React from 'react'
import { createRoot } from 'react-dom/client'
import {
  AlignmentType,
  Document,
  HeadingLevel,
  LineRuleType,
  Packer,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import { getReport } from '@/modules/reports/api'
import { getTemplateVersion } from '@/shared/api/templates'
import {
  BODY_FONT,
  BODY_FULL_WIDTH_PX,
  BODY_SIZE,
  INVISIBLE_TABLE_BORDERS,
  LINE_SPACING_AUTO_240THS,
  TITLE_SIZE,
  combinedBlocks,
  emptyParagraph,
  groupBlocksByRow,
  renderBlockPieces,
  sanitizeDepthGlyph,
  sanitizeFileName,
  triggerDownload,
} from '@/modules/reports/exportReportToDocx'
import { InlineReportView } from './InlineReportView'

// A4 dimensions in twips (1/1440 inch). Portrait = tall; landscape =
// wide. docx Section properties expect width × height; orientation is a
// separate flag but several Word builds key off the dims, so we pass
// both for safety.
const A4_PORTRAIT_WIDTH = 11906
const A4_PORTRAIT_HEIGHT = 16838

// 2-column landscape page geometry. Margins picked earlier in this
// file: top/bottom 1.5cm, left/right 1cm. Math here drives the
// Activities table's two columns AND the per-item maxImageWidthPx so
// captures fit cleanly inside half-page columns.
//
//   body width  = page width − left − right margins
//               = A4_PORTRAIT_HEIGHT (=landscape width) − 2 × 567 (≈1cm)
//   per column  = body / 2 (both columns equal, fixed layout)
//   cell inner  = column − 2 × cell margin (120 twips each side)
//                                          = column − 240
const LANDSCAPE_BODY_WIDTH_TWIPS = A4_PORTRAIT_HEIGHT - 2 * 567 // 15704
const LANDSCAPE_COL_WIDTH_TWIPS = Math.floor(LANDSCAPE_BODY_WIDTH_TWIPS / 2) // 7852
const LANDSCAPE_CELL_MARGIN_TWIPS = 120
const LANDSCAPE_CELL_INNER_TWIPS =
  LANDSCAPE_COL_WIDTH_TWIPS - 2 * LANDSCAPE_CELL_MARGIN_TWIPS // 7612

// Convert cell inner twips → pixels (96 DPI, 1440 twips/inch).
// This is the hard upper bound for any image emitted into a 2-col
// cell — going larger causes the image to overflow the column AND
// (because Word's auto-layout reflows the table) makes the OTHER
// column shrink to compensate, breaking the "two equal columns"
// promise.
const LANDSCAPE_CELL_INNER_PX = Math.floor(
  (LANDSCAPE_CELL_INNER_TWIPS / 1440) * 96,
) // ≈ 507

// Per-item maxImageWidthPx. 1-col uses the same default as the
// single-report exporter; 2-col uses the calculated cell-inner width
// minus a small safety buffer so anti-aliasing / rounding doesn't
// nudge the image past the cell.
const CONTENT_WIDTH_1COL_PX = BODY_FULL_WIDTH_PX // ~560
const CONTENT_WIDTH_2COL_PX = LANDSCAPE_CELL_INNER_PX - 20 // ~487

/**
 * @param {object} composite                       the composite read (with items[])
 * @param {object} options
 * @param {'portrait-1col'|'landscape-2col'} options.layout
 * @param {object} [options.sectionItemByCode]     workspace section taxonomy
 *                                                 lookup ({ [code]: { item,
 *                                                 category } }). Passed
 *                                                 through to renderBlockPieces
 *                                                 so long-text widgets emit
 *                                                 the "[단락구분] : 제목"
 *                                                 header same as the single-
 *                                                 report exporter. Omit /
 *                                                 leave empty to skip the
 *                                                 section prefix entirely.
 * @param {Function} [options.onProgress] same shape as report exporter
 */
/** Mount one item's report content offscreen, wait for charts to
 *  settle, run `runWithScope(containerEl)` to do its captures, then
 *  unmount. The container lives at `left:-10000px` so it has layout
 *  (required for chart/three.js renderers) but is invisible. */
async function withOffscreenItemMount(snapshot, runWithScope) {
  const container = document.createElement('div')
  container.style.cssText =
    'position:fixed;left:-10000px;top:0;width:800px;pointer-events:none;opacity:0;background:#ffffff'
  container.setAttribute('aria-hidden', 'true')
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(React.createElement(InlineReportView, { snapshot }))
  // Wait for InlineReportView to render + plotly/three to settle.
  // 700ms is generous but reliable; charts that haven't drawn yet
  // produce empty captures. Larger reports may need more; this is a
  // pragmatic default that works for typical pages.
  await new Promise((r) => setTimeout(r, 700))
  try {
    return await runWithScope(container)
  } finally {
    root.unmount()
    container.remove()
  }
}

export async function exportCompositeToDocx({
  composite,
  layout,
  sectionItemByCode,
  onProgress,
}) {
  const sectionLookup = sectionItemByCode ?? {}
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

  const items = Array.isArray(composite?.items) ? composite.items : []
  const totalItems = items.length
  emit({
    phase: 'start',
    total: totalItems,
    label: '종합보고 자료 준비 중...',
  })

  // 1) Resolve full report data + template registry for each item.
  //    Items referencing sub-composites are deferred — for v1 we
  //    render them as a single "[종합] {title}" link line (full
  //    recursive expansion is composite-of-composites territory and
  //    handled by Phase 9E). Items with `snapshot_content` use that
  //    frozen blob; live items fetch via getReport(id).
  const resolved = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    emit({
      phase: 'block',
      current: i + 1,
      total: totalItems,
      label: `안건 ${i + 1}/${totalItems} 불러오는 중`,
    })
    if (it.item_type === 'report' && it.ref_report?.id != null) {
      const reportId = it.ref_report.id
      let report = null
      if (it.snapshot_content) {
        // Snapshot is shaped like a partial report payload (we wrote
        // it that way in services.publish.freeze).
        report = {
          ...it.snapshot_content,
          id: reportId,
          template_id:
            it.snapshot_content.template_id ?? it.ref_report?.template_id,
          template_version:
            it.snapshot_content.template_version ??
            it.ref_report?.template_version,
        }
      } else {
        try {
          report = await getReport(reportId)
        } catch {
          report = null
        }
      }
      // Pre-load every page's template so renderBlockPieces can look
      // them up synchronously inside the loop. Same shape the report
      // exporter expects.
      const tplMap = new Map()
      const pages = Array.isArray(report?.pages) && report.pages.length > 0
        ? report.pages
        : report
          ? [
              {
                template_id: report.template_id,
                template_version: report.template_version,
                content: report.content ?? {},
                layout_overrides: report.layout_overrides,
                props_overrides: report.props_overrides,
                extra_blocks: [],
                blocks_order: [],
              },
            ]
          : []
      for (const p of pages) {
        const key = `${p.template_id}@${p.template_version}`
        if (tplMap.has(key)) continue
        try {
          const tpl = await getTemplateVersion(p.template_id, p.template_version)
          tplMap.set(key, tpl)
        } catch {
          tplMap.set(key, null)
        }
      }
      resolved.push({
        index: i,
        kind: 'report',
        item: it,
        report,
        pages,
        templateMap: tplMap,
        displayColumn: it.display_column === 2 ? 2 : 1,
      })
    } else if (it.item_type === 'composite' && it.ref_composite?.id != null) {
      resolved.push({
        index: i,
        kind: 'composite',
        item: it,
        displayColumn: it.display_column === 2 ? 2 : 1,
      })
    }
  }

  // Total widget count across all resolved items — drives the progress
  // bar at widget granularity (one tick per html2canvas capture / text
  // widget conversion). Item-level counting made long items look
  // frozen because each item could contain 20+ widgets.
  let totalWidgets = 0
  for (const r of resolved) {
    if (r.kind !== 'report') {
      totalWidgets += 1
      continue
    }
    for (const page of r.pages) {
      const tpl = r.templateMap.get(`${page.template_id}@${page.template_version}`)
      if (!tpl) continue
      totalWidgets += combinedBlocks(tpl, page).length
    }
  }
  totalWidgets = Math.max(totalWidgets, 1)
  let widgetsDone = 0
  function tickWidget(label) {
    widgetsDone += 1
    emit({
      phase: 'block',
      current: widgetsDone,
      total: totalWidgets,
      label,
    })
  }

  // 2) For visual widget capture, mount an offscreen container with
  //    InlineReportView for each report item. The widget Editors
  //    register themselves with DOM ids `block-<id>` once mounted,
  //    so the report exporter's convertVisualBlock can find them.
  //
  //    NOTE: v1 simplification — block IDs are template-scoped and
  //    can collide across items. To avoid the wrong DOM being grabbed
  //    when two items share a template, we render items SEQUENTIALLY
  //    later (capture item A's widgets, then unmount it, then move to
  //    item B). For now we render all upfront and accept the collision
  //    — typical composites have items from different templates.
  //    Improvement note left for later.

  // 3) Build the docx primitives.
  const isTwoCol = layout === 'landscape-2col'
  const perItemWidthPx = isTwoCol
    ? CONTENT_WIDTH_2COL_PX
    : CONTENT_WIDTH_1COL_PX

  // 종합 보고서 자체의 제목 줄은 일부러 비워둔다 — 사용자 요청.
  // 각 안건의 보고서 명이 `□ {title}` 형식으로 최상위 마커를 받기
  // 때문에 종합 제목까지 같이 보이면 시각 위계가 모호해진다.
  const headChildren = []

  async function buildItemChildren(group) {
    const out = []
    // 안건 보고서 명 — `□ {title}` 형식. 종합 자체 제목이 빠진 자리에
    // 각 안건이 top-level 처럼 보이도록. Heading 2 라 Word 의 outline
    // 패널엔 그대로 잡힌다.
    const itemTitle =
      group.kind === 'report'
        ? group.report?.title ?? group.item.ref_report?.title ?? `보고서 #${group.item.ref_report?.id}`
        : group.item.ref_composite?.title ?? `종합 #${group.item.ref_composite?.id}`
    out.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [
          new TextRun({
            text: `□ ${itemTitle}`,
            size: TITLE_SIZE,
            font: BODY_FONT,
            bold: true,
            color: '000000',
          }),
        ],
      }),
    )
    if (group.item.note) {
      out.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `메모: ${group.item.note}`,
              italics: true,
              color: '555555',
              size: BODY_SIZE,
              font: BODY_FONT,
            }),
          ],
        }),
      )
    }

    if (group.kind === 'composite') {
      tickWidget(`안건 ${group.index + 1} · 하위 종합보고`)
      out.push(
        new Paragraph({
          children: [
            new TextRun({
              text: '(하위 종합보고 — 본 문서에선 링크만 표기)',
              italics: true,
              color: '888888',
              size: BODY_SIZE,
              font: BODY_FONT,
            }),
          ],
        }),
      )
      out.push(emptyParagraph())
      return out
    }

    if (!group.report) {
      out.push(
        new Paragraph({
          children: [
            new TextRun({
              text: '[보고서 데이터 없음]',
              italics: true,
              color: '888888',
              size: BODY_SIZE,
              font: BODY_FONT,
            }),
          ],
        }),
      )
      out.push(emptyParagraph())
      return out
    }

    // Mount the item's full report offscreen so html2canvas captures
    // for visual widgets have a real DOM to read from. InlineReportView
    // is the read-only renderer composites use — same component that
    // backs the expand-and-preview flow on the detail page. After the
    // capture pass runs, the mount is unmounted to free memory + GPU
    // contexts (charts use WebGL contexts that are budget-capped per
    // browser).
    const snapshot = {
      pages: group.pages,
      page_width_px:
        group.report?.page_width_px ?? 800,
      page_gap_px: group.report?.page_gap_px,
      page_blend_blocks: group.report?.page_blend_blocks,
      page_rich_text_prefix_d0: group.report?.page_rich_text_prefix_d0,
      page_rich_text_prefix_d1: group.report?.page_rich_text_prefix_d1,
      page_rich_text_prefix_d2: group.report?.page_rich_text_prefix_d2,
    }
    // 안건별 depth-별 글리프. 각 depth 칸이 null 이면 module 기본으로
    // 폴백. 종합 차원의 일괄 override 는 아직 두지 않는다 — 사용자
    // 피드백 받아 보고 추가하기로.
    const itemDepthGlyphs = [
      sanitizeDepthGlyph(group.report?.page_rich_text_prefix_d0),
      sanitizeDepthGlyph(group.report?.page_rich_text_prefix_d1),
      sanitizeDepthGlyph(group.report?.page_rich_text_prefix_d2),
    ]
    await withOffscreenItemMount(snapshot, async (scopeEl) => {
      // Walk pages → row groups → blocks, same as the report exporter,
      // but scoped to the offscreen container's DOM so block-id
      // lookups don't collide with other reports that may be mounted
      // elsewhere on the page.
      for (const page of group.pages) {
        const tpl = group.templateMap.get(`${page.template_id}@${page.template_version}`)
        if (!tpl) continue
        const blocks = combinedBlocks(tpl, page)
        const rowGroups = groupBlocksByRow(blocks, page)
        for (const rowItems of rowGroups) {
          const usedCols = rowItems.reduce((s, x) => s + (x.layout.col_span || 0), 0)
          const slackCols = Math.max(0, 12 - usedCols)
          const isFullWidthSole = rowItems.length === 1 && slackCols === 0
          if (isFullWidthSole) {
            const blk = rowItems[0].block
            tickWidget(
              `안건 ${group.index + 1} · ${blk.type}`,
            )
            const pieces = await renderBlockPieces({
              block: blk,
              page,
              sectionItemByCode: sectionLookup,
              maxImageWidthPx: perItemWidthPx,
              scopeEl,
              depthGlyphs: itemDepthGlyphs,
            })
            for (const el of pieces) out.push(el)
            out.push(emptyParagraph())
            continue
          }
          const cells = []
          for (const { block, layout: lay } of rowItems) {
            tickWidget(
              `안건 ${group.index + 1} · ${block.type}`,
            )
            const cellWidthPx = Math.max(
              120,
              Math.floor((lay.col_span / 12) * perItemWidthPx),
            )
            const pieces = await renderBlockPieces({
              block,
              page,
              sectionItemByCode: sectionLookup,
              maxImageWidthPx: cellWidthPx,
              scopeEl,
              depthGlyphs: itemDepthGlyphs,
            })
            cells.push(
              new TableCell({
                children: pieces.length > 0 ? pieces : [emptyParagraph()],
                width: {
                  size: Math.round((lay.col_span / 12) * 100),
                  type: WidthType.PERCENTAGE,
                },
                margins: { top: 80, bottom: 80, left: 100, right: 100 },
              }),
            )
          }
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
          out.push(
            new Table({
              rows: [new TableRow({ children: cells })],
              width: { size: 100, type: WidthType.PERCENTAGE },
              borders: INVISIBLE_TABLE_BORDERS,
            }),
          )
          out.push(emptyParagraph())
        }
      }
    })
    // Spacer between items so the next item heading doesn't crowd.
    out.push(emptyParagraph())
    // Visually separate items with a thin rule (just an em-dash bar).
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: '— — — — — — — — — — — — — — —',
            color: 'cccccc',
            size: BODY_SIZE,
            font: BODY_FONT,
          }),
        ],
      }),
    )
    out.push(emptyParagraph())
    return out
  }

  // Render each item's children once. Progress is emitted at the
  // widget level inside buildItemChildren (via tickWidget) — emitting
  // again here would either double-count or stall the bar during the
  // long capture of a single item.
  const itemsChildren = []
  for (let i = 0; i < resolved.length; i++) {
    const ch = await buildItemChildren(resolved[i])
    itemsChildren.push({ group: resolved[i], children: ch })
  }

  // 그룹 헤더 `[그룹명]` — 같은 group_name 을 가진 연속 안건들 중 첫
  // 안건 직전에 한 줄. 그룹이 바뀔 때 (또는 처음 그룹이 등장할 때) emit.
  function groupHeaderParagraph(name) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [
        new TextRun({
          text: `[${name}]`,
          bold: true,
          size: TITLE_SIZE,
          font: BODY_FONT,
          color: '000000',
        }),
      ],
    })
  }

  /** itemsChildren 의 일부(또는 전부)를 받아 group 헤더가 적절히 끼워진
   *  flat paragraph 배열을 돌려준다. prev 는 이전 (다른 컬럼 / 흐름) 의
   *  마지막 그룹을 모를 때 null. 같은 컬럼 / 단일 흐름 안에서만 비교. */
  function flattenWithGroupHeaders(entries) {
    const out = []
    let prevGroup = null
    for (const { group, children } of entries) {
      const gn = group.item?.group_name || null
      if (gn && gn !== prevGroup) {
        out.push(groupHeaderParagraph(gn))
      }
      out.push(...children)
      prevGroup = gn
    }
    return out
  }

  // Compose section children honoring the layout choice.
  let sectionChildren
  if (isTwoCol) {
    // 2-row layout table:
    //   Row 1 — single merged cell "Activities" (header)
    //   Row 2 — left/right cells grouped by item.display_column
    //
    // Borders intentionally NOT overridden — falls back to docx-js
    // defaults which render Word's thin black grid. Different from
    // the invisible-borders pattern used elsewhere in this file.
    // 컬럼별로 entries 분리한 뒤 각자 그룹 헤더를 끼워 flatten.
    // 같은 그룹 안건이 좌/우 양쪽에 흩어져 있으면 각 컬럼마다 헤더가
    // 한 번씩 들어간다 (사용자가 굳이 그렇게 배치했다면 그게 의도).
    const leftEntries = []
    const rightEntries = []
    for (const entry of itemsChildren) {
      ;(entry.group.displayColumn === 2 ? rightEntries : leftEntries).push(entry)
    }
    const leftChildren = flattenWithGroupHeaders(leftEntries)
    const rightChildren = flattenWithGroupHeaders(rightEntries)
    if (leftChildren.length === 0) leftChildren.push(emptyParagraph())
    if (rightChildren.length === 0) rightChildren.push(emptyParagraph())
    sectionChildren = [
      ...headChildren,
      new Table({
        rows: [
          new TableRow({
            // Header row — "Activities" centered, single cell that
            // spans both columns via columnSpan.
            children: [
              new TableCell({
                columnSpan: 2,
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                      new TextRun({
                        text: 'Activities',
                        bold: true,
                        size: TITLE_SIZE,
                        font: BODY_FONT,
                        color: '000000',
                      }),
                    ],
                  }),
                ],
                margins: {
                  top: 120,
                  bottom: 120,
                  left: LANDSCAPE_CELL_MARGIN_TWIPS,
                  right: LANDSCAPE_CELL_MARGIN_TWIPS,
                },
              }),
            ],
          }),
          new TableRow({
            // Body row — items distributed left vs right by their
            // display_column attribute. Cell widths set in EXACT
            // twips (not percentages) so Word's auto-layout can't
            // reflow the columns based on content, which was making
            // a long inner image stretch one cell past 50%.
            children: [
              new TableCell({
                children: leftChildren,
                width: {
                  size: LANDSCAPE_COL_WIDTH_TWIPS,
                  type: WidthType.DXA,
                },
                margins: {
                  top: 120,
                  bottom: 120,
                  left: LANDSCAPE_CELL_MARGIN_TWIPS,
                  right: LANDSCAPE_CELL_MARGIN_TWIPS,
                },
              }),
              new TableCell({
                children: rightChildren,
                width: {
                  size: LANDSCAPE_COL_WIDTH_TWIPS,
                  type: WidthType.DXA,
                },
                margins: {
                  top: 120,
                  bottom: 120,
                  left: LANDSCAPE_CELL_MARGIN_TWIPS,
                  right: LANDSCAPE_CELL_MARGIN_TWIPS,
                },
              }),
            ],
          }),
        ],
        // Fixed layout + explicit column widths = Word locks the
        // table to these dimensions and content reflows inside.
        // Without this, a wide image in one cell stretches that
        // cell while squashing the other (auto layout), breaking
        // the "two equal columns" promise.
        layout: TableLayoutType.FIXED,
        columnWidths: [LANDSCAPE_COL_WIDTH_TWIPS, LANDSCAPE_COL_WIDTH_TWIPS],
        width: { size: LANDSCAPE_BODY_WIDTH_TWIPS, type: WidthType.DXA },
      }),
    ]
  } else {
    // 1-col: items in declaration order. 그룹 헤더는 flatten 시 끼움.
    sectionChildren = [
      ...headChildren,
      ...flattenWithGroupHeaders(itemsChildren),
    ]
  }

  emit({ phase: 'packing', label: 'Word 파일로 묶는 중...' })
  const doc = new Document({
    creator: 'ReportArchive',
    title: composite.title || '',
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
    sections: [
      {
        properties: isTwoCol
          ? {
              page: {
                size: {
                  // ⚠ docx-js v9 의 createPageSize 는 orientation=
                  //   LANDSCAPE 일 때 입력 width/height 를 알아서
                  //   swap 해서 OOXML 에 쓴다. 그러니 여기에는 항상
                  //   PORTRAIT 기준 dims 를 넣고 orientation 만 바꿈.
                  //   landscape dims 를 미리 swap 해서 넣으면 라이브
                  //   러리가 또 swap → 결국 portrait 으로 출력되어
                  //   Word 가 세로로 표시. (실제 발생한 버그)
                  width: A4_PORTRAIT_WIDTH,
                  height: A4_PORTRAIT_HEIGHT,
                  orientation: PageOrientation.LANDSCAPE,
                },
                // 가로 2열 모드 전용 페이지 여백 — 위/아래 1.5cm,
                // 좌/우 1cm. 단위: twips (1cm ≈ 567twips). 좁은 좌우
                // 여백으로 두 칸 콘텐츠 폭을 최대한 확보.
                margin: {
                  top: 850,    // 1.5cm
                  bottom: 850, // 1.5cm
                  left: 567,   // 1cm
                  right: 567,  // 1cm
                  header: 425,
                  footer: 425,
                  gutter: 0,
                },
              },
            }
          : {
              page: {
                size: {
                  width: A4_PORTRAIT_WIDTH,
                  height: A4_PORTRAIT_HEIGHT,
                  orientation: PageOrientation.PORTRAIT,
                },
              },
            },
        children: sectionChildren,
      },
    ],
  })

  const blob = await Packer.toBlob(doc)
  const suffix = isTwoCol ? '-landscape-2col' : ''
  const filename = `${sanitizeFileName(composite.title || 'composite')}-${new Date()
    .toISOString()
    .slice(0, 10)}${suffix}.docx`
  triggerDownload(blob, filename)
  emit({ phase: 'done', label: '저장 완료' })
}
