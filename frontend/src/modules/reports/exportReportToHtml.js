// Single-file HTML exporter for the report detail view.
//
// Captures the currently rendered DOM (caller is expected to flip the
// report into `printing` mode first so all blocks are read-only and
// every page is mounted) and produces a self-contained .html file:
//
//   - Every <style> rule from `document.styleSheets` is collected and
//     embedded into a single <style> block (Vite's bundled CSS plus any
//     dev-mode injected styles).
//   - Every <img src> inside the captured DOM is fetched through the
//     authed apiClient and converted to a base64 data URI so the file
//     opens on a machine with no network access.
//   - The app shell's toolbar, page strip, and autoFit measurement
//     mirrors are stripped from the clone — only the report body is
//     kept.
//
// Result: a portable archive of the report that any browser can open
// offline and that visually matches the editor's view-mode rendering.

import { apiClient } from '@/shared/api/client'

export async function exportReportToHtml({ draft }) {
  const sourceRoot = document.querySelector('.report-detail-root')
  if (!sourceRoot) {
    throw new Error('보고서 영역(.report-detail-root)을 찾을 수 없습니다.')
  }

  // Work on a clone so we can strip chrome / inline images without
  // affecting the live DOM the user is still looking at.
  const clone = sourceRoot.cloneNode(true)

  // Strip the parts of the screen that aren't the report itself.
  // Annotation edit chrome (style bar, label editor input) only
  // mounts in editor mode — listed here defensively so even if the
  // caller forgets to flip into printing mode, the saved file stays
  // clean of UI controls. Annotation SHAPES (vlines, ranges, points,
  // …) are plain SVG inside the report DOM, so they're captured
  // automatically and don't need special handling here.
  clone
    .querySelectorAll(
      '.report-detail-toolbar, .report-detail-pagestrip, .report-detail-floating, .report-autofit-mirror, .annotation-style-bar, .annotation-label-editor',
    )
    .forEach((el) => el.remove())
  // ProseMirror leaves `contenteditable=""` everywhere; harmless for a
  // static viewer but distracting if the file is ever inspected, so
  // strip those + a couple of common a11y artefacts.
  clone.querySelectorAll('[contenteditable]').forEach((el) => {
    el.removeAttribute('contenteditable')
  })
  clone.querySelectorAll('[role="textbox"]').forEach((el) => {
    el.removeAttribute('role')
  })

  // Inject a print-only title block at the top so the saved file is
  // self-explanatory even without the toolbar. Uses inline styles so
  // it doesn't depend on Tailwind classes that might not match in the
  // stripped CSS bundle.
  const title = draft?.title || '(제목 없음)'
  const date = draft?.report_date || ''
  const titleBlock = document.createElement('div')
  titleBlock.setAttribute(
    'style',
    'padding: 24px 32px 0; font-family: system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;',
  )
  titleBlock.innerHTML =
    '<h1 style="margin:0;font-size:24px;font-weight:700;color:#111;">' +
    escapeHtml(title) +
    '</h1>' +
    (date
      ? '<div style="margin-top:4px;color:#666;font-size:13px;">' +
        escapeHtml(date) +
        '</div>'
      : '')
  clone.prepend(titleBlock)

  // Inline every reachable <img> as a data URI so the file is fully
  // portable. Same-origin /api/files/... assets need the bearer
  // token, which apiClient adds automatically.
  await inlineImages(clone)

  // Pull in every stylesheet currently affecting the page.
  const css = await collectAllStylesheets()

  // Overrides specific to the saved HTML. The live page uses an app-shell
  // flex layout (toolbar / pagestrip / scroll-area pinned inside a
  // viewport-tall flex column); when those siblings are stripped, the
  // remaining flex container still tries to share its row with the
  // prepended title block, pushing content to the right. Plus narrow-mode
  // wraps content in `max-w-5xl mx-auto` which centers it. Both reset to
  // plain block flow so the file reads as a normal top-to-bottom
  // document with content flush to the left padding.
  const exportOverrides = [
    // Root + the single inner wrapper (direct child) lose their
    // app-shell flex/full-height chrome; widget cards nested deeper
    // keep their own intentional flex layouts.
    '.report-detail-root {',
    '  display: block !important;',
    '  height: auto !important;',
    '  min-height: 0 !important;',
    '}',
    '.report-detail-root > * {',
    '  display: block !important;',
    '  flex: none !important;',
    '  height: auto !important;',
    '  min-height: 0 !important;',
    '  width: auto !important;',
    '}',
    // Radix ScrollArea is JS-driven; statically it just clips. Let
    // content flow into native page scroll instead.
    '.report-detail-root [data-radix-scroll-area-viewport],',
    '.report-detail-root [data-radix-scroll-area-root] {',
    '  height: auto !important;',
    '  max-height: none !important;',
    '  overflow: visible !important;',
    '  width: 100% !important;',
    '}',
    // Drop centering / max-width wrappers so the saved document reads
    // left-aligned regardless of viewer window width.
    '.report-detail-root .mx-auto {',
    '  margin-left: 0 !important;',
    '  margin-right: 0 !important;',
    '}',
    '.report-detail-root .max-w-5xl {',
    '  max-width: none !important;',
    '}',
  ].join('\n')

  const htmlClassAttr = document.documentElement.className
    ? ` class="${escapeAttr(document.documentElement.className)}"`
    : ''
  const colorScheme = document.documentElement.style.colorScheme || ''

  const html =
    '<!DOCTYPE html>\n' +
    '<html lang="ko"' +
    htmlClassAttr +
    '>\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' +
    escapeHtml(title) +
    '</title>\n' +
    (colorScheme
      ? '<meta name="color-scheme" content="' +
        escapeAttr(colorScheme) +
        '">\n'
      : '') +
    '<style>\n' +
    css +
    '\n</style>\n' +
    // The export overrides are emitted *after* the bundled CSS so the
    // cascade order (later wins at equal specificity) is on their side.
    '<style data-source="report-html-export">\n' +
    exportOverrides +
    '\n</style>\n' +
    '</head>\n' +
    '<body style="margin:0;background:#fff;">\n' +
    clone.outerHTML +
    '\n</body>\n</html>\n'

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const filename =
    sanitizeFileName(title) +
    '-' +
    new Date().toISOString().slice(0, 10) +
    '.html'
  triggerDownload(blob, filename)
}

// --- Stylesheet collection ------------------------------------------- //

// document.styleSheets includes both <link rel="stylesheet"> files (the
// Vite-bundled CSS in production, HMR-injected blobs in dev) and inline
// <style> tags. We read .cssRules synchronously when same-origin; when
// the browser blocks that with a security error (cross-origin sheet),
// we fall back to fetching the href.
async function collectAllStylesheets() {
  const chunks = []
  for (const sheet of Array.from(document.styleSheets)) {
    const rulesText = await readSheet(sheet)
    if (rulesText) chunks.push(rulesText)
  }
  return chunks.join('\n\n')
}

async function readSheet(sheet) {
  try {
    const rules = sheet.cssRules
    if (rules && rules.length > 0) {
      return Array.from(rules)
        .map((r) => r.cssText)
        .join('\n')
    }
  } catch (_err) {
    // Cross-origin access denied — fall through to fetch fallback.
  }
  if (sheet.href) {
    try {
      const res = await fetch(sheet.href)
      if (res.ok) return await res.text()
    } catch (_err) {
      // Network or CORS — skip silently.
    }
  }
  return ''
}

// --- Image inlining --------------------------------------------------- //

async function inlineImages(rootEl) {
  const imgs = Array.from(rootEl.querySelectorAll('img'))
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src')
      if (!src) return
      if (src.startsWith('data:')) return
      try {
        // Use apiClient for /api/files paths (needs auth header). For
        // other relative URLs (rare — favicons, etc.) plain fetch
        // works because the page is same-origin.
        const res = src.startsWith('/api/')
          ? await apiClient.get(src, { responseType: 'blob' })
          : await fetch(src).then((r) => r.blob().then((b) => ({ data: b })))
        const blob = res.data
        const dataUri = await blobToDataUri(blob)
        img.setAttribute('src', dataUri)
        img.removeAttribute('srcset') // any responsive variants are now stale
      } catch (err) {
        // Leave broken-image alt text in place — better than failing the
        // whole export over one missing asset.
        console.warn('[html-export] image inline failed', src, err)
      }
    }),
  )
}

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

// --- Helpers --------------------------------------------------------- //

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;')
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
  // Defer revoke — 즉시 revoke 시 Chromium 다운로드 fetch 가 끝나기 전에
  // URL 이 사라져 콘솔에 ERR_FILE_NOT_FOUND. (자세한 사유는 exportReportToDocx
  // 의 같은 함수 주석 참고.)
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
