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
  Document,
  HeadingLevel,
  ImageRun,
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

// docx `size` is in half-points (28 = 14pt, 20 = 10pt). One pair of
// constants for every TextRun emitted from this file — TITLE_SIZE for
// anything that reads as a heading/label, BODY_SIZE for flowing text.
// Inline-formatting from rich_text (the user-picked size via the
// TipTap editor) overrides BODY_SIZE on a per-run basis; everything
// else uses these two.
const TITLE_SIZE = 28 //  14pt
const BODY_SIZE = 20 //   10pt

// --- Public entrypoint ------------------------------------------------ //

export async function exportReportToDocx({
  draft,
  pageTemplateMap,
  sectionItemByCode,
}) {
  const children = []

  // Title block
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [
        new TextRun({
          text: draft.title || '(제목 없음)',
          size: TITLE_SIZE,
          // Word's TITLE / HEADING_x styles default to dark-blue text.
          // Force black on every heading-tier run so the export looks
          // like a plain manuscript instead of carrying Word's heading
          // palette into our document.
          color: '000000',
        }),
      ],
    }),
  )
  if (draft.report_date) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: draft.report_date,
            italics: true,
            size: BODY_SIZE,
          }),
        ],
      }),
    )
  }
  children.push(emptyParagraph())

  const pages = draft.pages ?? []
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

    for (const block of blocks) {
      const content = page.content?.[block.id] ?? {}
      const propsOverride = page.props_overrides?.[block.id] ?? null
      const effectiveProps = mergePropsOverride(block.props, propsOverride)
      const sectionCode = page.block_sections?.[block.id]
      const sectionEntry = sectionCode
        ? sectionItemByCode?.[sectionCode]
        : null

      // Section header chip → small bold label paragraph. Used to
      // render in the category's color, but the user wants headers
      // black in Word for a cleaner manuscript look — the category
      // is still visually distinct via the `[Category · Item]`
      // bracketing.
      if (sectionEntry?.item && sectionEntry?.category) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `[${sectionEntry.category.name} · ${sectionEntry.item.label}]`,
                bold: true,
                size: BODY_SIZE,
                color: '000000',
              }),
            ],
          }),
        )
      }

      try {
        const els = await convertBlock(block, effectiveProps, content)
        for (const el of els) children.push(el)
      } catch (err) {
        // Don't let one bad widget kill the whole export. Surface a
        // short placeholder and keep going.
        console.warn('[docx] block convert failed', block.id, err)
        children.push(
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
      children.push(emptyParagraph())
    }
  }

  const doc = new Document({
    creator: 'ReportArchive',
    title: draft.title || '',
    sections: [{ properties: {}, children }],
  })

  const blob = await Packer.toBlob(doc)
  const filename = `${sanitizeFileName(draft.title || 'report')}-${new Date()
    .toISOString()
    .slice(0, 10)}.docx`
  triggerDownload(blob, filename)
}

// --- Block dispatcher ------------------------------------------------- //

async function convertBlock(block, props, content) {
  const out = []

  // Caption (if any) → bold heading-3 paragraph above the body.
  const caption = content?.caption
  if (caption) {
    out.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_3,
        children: [
          new TextRun({ text: caption, size: TITLE_SIZE, color: '000000' }),
        ],
      }),
    )
  }

  switch (block.type) {
    case 'heading':
      out.push(...convertHeading(props, content))
      break
    case 'rich_text':
      out.push(...convertRichText(content))
      break
    case 'bulleted_list':
      out.push(...convertBulletedList(content))
      break
    case 'key_value':
      out.push(...convertKeyValue(props, content))
      break
    case 'table':
      out.push(...convertTable(props, content))
      break
    case 'image': {
      // Annotated single-image cells go through the html2canvas path
      // so the annotation SVG overlay bakes into the captured PNG.
      // Plain galleries (no marks) keep the raw-file path so the
      // exported image stays at its native resolution.
      const hasAnnotations =
        Array.isArray(content?.annotations) && content.annotations.length > 0
      if (hasAnnotations) {
        out.push(...(await convertVisualBlock(block.id, 'image')))
      } else {
        out.push(...(await convertImage(content)))
      }
      // Always echo annotation labels as plain text after the image
      // — DOCX search treats the image as opaque pixels otherwise.
      out.push(...convertAnnotationLabels(content?.annotations))
      break
    }
    case 'attachment':
      out.push(...convertAttachment(content))
      break
    case 'chart':
    case 'scatter':
    case 'scatter3d':
    case 'heatmap':
    case 'radar':
    case 'equation':
    case 'flowchart':
    case 'milestone':
    case 'progress_bar':
    case 'raci_matrix':
      out.push(...(await convertVisualBlock(block.id, block.type)))
      // Chart annotations get captured into the PNG too, but the text
      // labels need to be reachable by DOCX search / screen readers.
      // scatter3d has no annotation surface (rotation makes 2-D pixel
      // marks meaningless) so no label echoing for it.
      if (block.type === 'chart' || block.type === 'scatter') {
        out.push(...convertAnnotationLabels(content?.annotations))
      }
      break
    default:
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

const DEPTH_PREFIX = ['□', '–', '·', '·', '·', '·']
const RT_INDENT_TWIPS_PER_DEPTH = 360 // ~0.25in

function convertRichText(content) {
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
  return items.map((it) => {
    const depth = clamp(it?.depth ?? 0, 0, 5)
    const prefix = `${DEPTH_PREFIX[depth] ?? '·'} `
    const runs = htmlToTextRuns(it?.html, it?.text ?? '')
    runs.unshift(
      new TextRun({ text: prefix, color: '888888', size: BODY_SIZE }),
    )
    return new Paragraph({
      indent: { left: depth * RT_INDENT_TWIPS_PER_DEPTH },
      children: runs,
    })
  })
}

/** Minimal markdown → outline parser for the legacy `content.markdown`
 *  shape. Each non-empty line becomes one item; depth is inferred from
 *  bullet prefix (□/–/·/-) or leading whitespace. Mirrors the spirit
 *  of RichText.jsx's parseMarkdownToItems but doesn't pull the whole
 *  widget into the exporter bundle. */
function markdownToItemsForExport(md) {
  if (typeof md !== 'string' || !md.trim()) return []
  const PREFIX_DEPTH = { '□': 0, '–': 1, '-': 1, '*': 1, '•': 1, '·': 2 }
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

async function convertImage(content) {
  const files = Array.isArray(content?.files) ? content.files : []
  const out = []
  for (const file of files) {
    if (!file?.file_id) continue
    try {
      const buf = await fetchAsArrayBuffer(
        `/api/files/${encodeURIComponent(file.file_id)}`,
      )
      const { width, height } = await readImageSize(buf)
      const fitted = fitInto(width, height, 500, 380)
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
async function convertVisualBlock(blockId, blockType) {
  const el = document.getElementById(`block-${blockId}`)
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
    })
    const blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/png'),
    )
    if (!blob) throw new Error('toBlob returned null')
    const buf = await blob.arrayBuffer()
    const fitted = fitInto(canvas.width, canvas.height, 560, 420)
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

function lookupTemplate(pageTemplateMap, page) {
  if (!page || !pageTemplateMap) return null
  const key = `${page.template_id}@${page.template_version}`
  // `pageTemplateMap` is a Map keyed by `<template_id>@<version>`, whose
  // value is the template object itself (schema, name, etc.).
  return typeof pageTemplateMap.get === 'function'
    ? pageTemplateMap.get(key) ?? null
    : pageTemplateMap[key] ?? null
}

function combinedBlocks(template, page) {
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

function emptyParagraph() {
  return new Paragraph({ children: [new TextRun({ text: '' })] })
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n | 0))
}

function sanitizeFileName(name) {
  return (
    String(name || '')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .trim()
      .slice(0, 80) || 'report'
  )
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
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
