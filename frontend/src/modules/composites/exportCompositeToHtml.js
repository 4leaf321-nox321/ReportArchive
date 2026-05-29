// Single-file HTML exporter for the composite detail view.
//
// Mirrors exportReportToHtml.js but for the composite page — a stacked
// list of report/composite items where each expanded item embeds
// `<InlineReportView>` content. The caller is expected to have
// already forced every item into the expanded state (so all embedded
// content is mounted in the DOM) before invoking this; otherwise the
// saved file will reflect whatever was open at capture time.
//
// What the user sees in the saved file:
//   - Top: composite title + 전체화면 toggle
//   - Body: the cloned composite content (title block, description,
//     items list) with every item expanded
//   - No editor chrome (action buttons, drag handles, column / group
//     toggles, move-up/move-down arrows are all stripped via the
//     shared `[data-export-exclude]` marker)
//
// We share canvas / Plotly / image / stylesheet / utility helpers
// with the report exporter (re-exported from
// `@/modules/reports/exportReportToHtml`) so behavior stays in lockstep
// for embedded charts inside InlineReportView.

import {
  collectAllStylesheets,
  escapeAttr,
  escapeHtml,
  escapeScriptJson,
  inlineImages,
  PLOTLY_INIT_SCRIPT,
  prepareClonedPlotlyPlaceholders,
  clearLivePlotlyAnnotations,
  replaceClonedCanvases,
  sanitizeFileName,
  scrubResizingPlaceholders,
  snapshotCanvases,
  snapshotPlotlyCharts,
  triggerDownload,
} from '@/modules/reports/exportReportToHtml'

export async function exportCompositeToHtml({ composite, title, onProgress, signal }) {
  const report = typeof onProgress === 'function' ? onProgress : () => {}
  // Cancellation hook — same shape as exportReportToHtml. Caller wires
  // the overlay`s 취소 button to an AbortController and passes its
  // signal here; we throw AbortError at every step between awaits.
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
  }
  throwIfAborted()
  const sourceRoot = document.querySelector('.composite-detail-root')
  if (!sourceRoot) {
    throw new Error('종합보고 영역(.composite-detail-root)을 찾을 수 없습니다.')
  }

  // Measure the live composite root width BEFORE anything else.
  // Static widgets (Recharts SVG, html2canvas captures inside
  // InlineReportView) were rendered against THIS width — particularly
  // the 2-column grid cells whose width is half of this. If the saved
  // file shrinks the root container below this measurement, the
  // captured fixed-size widgets overflow their cells (the original
  // "2단보기에서 위젯이 벗어남" complaint). We bake this width onto
  // the clone as inline `width:` so the saved viewer renders cells at
  // exactly the cell-width the widgets were drawn for. rv-stage`s
  // overflow:auto picks up any horizontal scroll if the viewer window
  // is narrower than this.
  const capturedRootWidth = Math.round(
    sourceRoot.getBoundingClientRect().width,
  )

  // Capture live chart state BEFORE cloning — same reasoning as the
  // report exporter: cloneNode loses canvas pixel buffers and Plotly`s
  // attached spec, so we snapshot the live DOM and reattach to the
  // clone afterward.
  report({ phase: 'snapshot', label: '차트 / 캔버스 스냅샷 중...' })
  const plotlySpecs = snapshotPlotlyCharts(sourceRoot)
  const canvasSnapshots = snapshotCanvases(sourceRoot)

  const clone = sourceRoot.cloneNode(true)
  // Pin the clone to exactly the live captured width so the 2-column
  // grid cells render at the same width the widgets were measured
  // against. `!important`-style enforcement via inline (inline beats
  // any class-based width:) covers Tailwind utilities and the viewer
  // CSS alike.
  if (capturedRootWidth > 0) {
    clone.style.width = capturedRootWidth + 'px'
    clone.style.maxWidth = capturedRootWidth + 'px'
    clone.style.minWidth = capturedRootWidth + 'px'
  }
  clearLivePlotlyAnnotations(sourceRoot)
  replaceClonedCanvases(clone, canvasSnapshots)
  prepareClonedPlotlyPlaceholders(clone, plotlySpecs)
  const hasPlotly = plotlySpecs.some((s) => s != null)

  // Wipe any straggling "크기 조정 중…" placeholders — same defensive
  // tail as the report exporter (the InlineReportView`s embedded chart
  // widgets share the same ResizeObserver debounce pattern).
  scrubResizingPlaceholders(clone)

  // Strip editor chrome marked with `data-export-exclude` (top
  // action row, items-card header buttons, per-item edit controls,
  // expand/collapse chevron) and the progress overlay if it bled
  // into the cloned subtree. ProseMirror leaves `contenteditable=""`
  // everywhere; harmless but distracting in a saved archive.
  clone
    .querySelectorAll('[data-export-exclude], [data-export-overlay]')
    .forEach((el) => el.remove())
  clone.querySelectorAll('[contenteditable]').forEach((el) => {
    el.removeAttribute('contenteditable')
  })
  clone.querySelectorAll('[role="textbox"]').forEach((el) => {
    el.removeAttribute('role')
  })
  // Inputs / textareas that survived inside ItemRow note fields,
  // dropdowns, etc. (rare — `editing=false` already hides most) —
  // demote to plain text spans so the saved file doesn`t expose
  // half-functional form controls.
  clone.querySelectorAll('input, textarea, select').forEach((el) => {
    el.removeAttribute('disabled')
    el.setAttribute('readonly', '')
    el.setAttribute('tabindex', '-1')
  })

  throwIfAborted()
  report({ phase: 'images', label: '이미지 인라인 중...' })
  await inlineImages(clone)
  throwIfAborted()

  const composedTitle = title || composite?.title || '(제목 없음)'
  const viewerShell = buildCompositeViewerShell({ clone, title: composedTitle })

  report({ phase: 'css', label: '스타일 수집 중...' })
  const css = await collectAllStylesheets()
  throwIfAborted()

  // Plotly bundle — only when at least one Plotly chart is in the
  // composite (typically embedded via InlineReportView). Same lazy
  // import pattern as the report exporter; ~1 MB gzip.
  let plotlyJs = ''
  let plotlySpecsJson = ''
  if (hasPlotly) {
    report({ phase: 'plotly', label: 'Plotly 라이브러리 인라인 (~1MB)...' })
    try {
      const mod = await import('plotly.js-dist-min/plotly.min.js?raw')
      throwIfAborted()
      plotlyJs = mod.default || mod
      // Carry the captured live dimensions through so the viewer init
      // script can pin layout.width / layout.height instead of letting
      // Plotly measure a possibly-still-settling container — same fix
      // as exportReportToHtml. Without this the saved file re-renders
      // charts at whatever size the container box happens to have at
      // window.load time, which often differs from the editor capture.
      const exportable = plotlySpecs.map((s) =>
        s
          ? { data: s.data, layout: s.layout, exportSize: s._exportSize ?? null }
          : null,
      )
      plotlySpecsJson = JSON.stringify(exportable)
    } catch (err) {
      console.warn('[composite-html-export] plotly inline failed', err)
      viewerShell.querySelectorAll('[data-plotly-spec-id]').forEach((el) => {
        el.removeAttribute('data-plotly-spec-id')
      })
    }
  }

  // Saved-file specific overrides. The editor wraps the composite in
  // `<div className="p-6 space-y-6">`; that padding is fine but we
  // override the AppShell-relative flex/full-height chrome on any
  // ancestor that survived the clone, and unset a few items-card
  // styles that depended on the editor`s `editing` flag.
  const exportOverrides = [
    '.composite-detail-root {',
    '  display: block !important;',
    '  height: auto !important;',
    '}',
    // The expand chevron is stripped, but its surrounding `flex
    // items-start gap-1.5` row leaves a small left gutter from the
    // missing button — collapse it so titles align flush.
    '.composite-detail-root [data-composite-item-row] > .flex { gap: 8px !important; }',
    '.composite-detail-root [data-composite-item-row] > .flex > button[type="button"][aria-label="펼치기"], ',
    '.composite-detail-root [data-composite-item-row] > .flex > button[type="button"][aria-label="접기"] {',
    '  display: none !important;',
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
    escapeHtml(composedTitle) +
    '</title>\n' +
    (colorScheme
      ? '<meta name="color-scheme" content="' +
        escapeAttr(colorScheme) +
        '">\n'
      : '') +
    '<style>\n' +
    css +
    '\n</style>\n' +
    '<style data-source="composite-html-export">\n' +
    exportOverrides +
    '\n</style>\n' +
    '<style data-source="composite-html-viewer">\n' +
    COMPOSITE_VIEWER_CSS +
    '\n</style>\n' +
    '</head>\n' +
    '<body style="margin:0;background:#f4f4f5;">\n' +
    viewerShell.outerHTML +
    '\n<script>\n' +
    COMPOSITE_VIEWER_SCRIPT +
    '\n</script>\n' +
    (plotlyJs
      ? '\n<script>\n' +
        plotlyJs +
        '\n</script>\n' +
        '<script type="application/json" id="rv-plotly-specs">' +
        escapeScriptJson(plotlySpecsJson) +
        '</script>\n' +
        '<script>\n' +
        PLOTLY_INIT_SCRIPT +
        '\n</script>\n'
      : '') +
    '</body>\n</html>\n'

  throwIfAborted()
  report({ phase: 'finalize', label: '파일 생성 중...' })
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const filename =
    sanitizeFileName(composedTitle) +
    '-' +
    new Date().toISOString().slice(0, 10) +
    '.html'
  triggerDownload(blob, filename)
}

// Minimal viewer chrome — no page nav (composites aren`t paginated),
// just a sticky title bar with a fullscreen toggle and a scrollable
// stage that holds the cloned composite content.

function buildCompositeViewerShell({ clone, title }) {
  const shell = document.createElement('div')
  shell.className = 'cv-shell'

  const toolbar = document.createElement('header')
  toolbar.className = 'cv-toolbar'
  toolbar.innerHTML =
    '<div class="cv-title">' + escapeHtml(title) + '</div>' +
    '<button type="button" class="cv-fs" title="전체화면 토글 (F)" aria-label="전체화면">⛶ 전체화면</button>'

  const stage = document.createElement('div')
  stage.className = 'cv-stage'
  stage.appendChild(clone)

  shell.appendChild(toolbar)
  shell.appendChild(stage)
  return shell
}

const COMPOSITE_VIEWER_CSS = [
  'html, body { background: #f4f4f5; margin: 0; padding: 0; overflow: hidden; height: 100%; }',
  '.cv-shell {',
  '  position: fixed;',
  '  inset: 0;',
  '  display: flex;',
  '  flex-direction: column;',
  '  background: #f4f4f5;',
  '  overflow: hidden;',
  '}',
  '.cv-shell:fullscreen { background: #f4f4f5; }',
  '.cv-toolbar {',
  '  flex: 0 0 auto;',
  '  z-index: 100;',
  '  background: #ffffff;',
  '  border-bottom: 1px solid #e5e7eb;',
  '  padding: 8px 14px;',
  '  display: flex;',
  '  align-items: center;',
  '  gap: 12px;',
  '  font-family: system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;',
  '}',
  '.cv-title {',
  '  flex: 1;',
  '  min-width: 0;',
  '  font-size: 13px;',
  '  font-weight: 600;',
  '  color: #18181b;',
  '  overflow: hidden;',
  '  text-overflow: ellipsis;',
  '  white-space: nowrap;',
  '}',
  '.cv-fs {',
  '  padding: 5px 11px;',
  '  border: 1px solid #d4d4d8;',
  '  background: #ffffff;',
  '  color: #18181b;',
  '  border-radius: 4px;',
  '  cursor: pointer;',
  '  font-size: 12px;',
  '  font-family: inherit;',
  '  white-space: nowrap;',
  '}',
  '.cv-fs:hover { background: #f4f4f5; }',
  '.cv-stage {',
  '  flex: 1 1 auto;',
  '  min-height: 0;',
  '  overflow: auto;',
  '  padding: 0;',
  '  background: #f4f4f5;',
  '}',
  // Composite items: keep the editor`s card chrome, just neutralize
  // hover/active/dragging states that came from React class strings.
  // NOTE: max-width is NOT set here — the export bakes the live
  // captured width onto the cloned root as inline `width: Npx` so
  // every 2-column cell renders at exactly the cell-width the static
  // widgets were drawn for. A CSS max-width here would silently
  // shrink the root below the captured width and re-introduce the
  // "2단보기 위젯이 cell 밖으로 빠져나옴" overflow.
  '.cv-stage .composite-detail-root { background: #ffffff; margin: 0 auto; padding: 24px; }',
  '.cv-stage [data-composite-item-row] { cursor: default !important; opacity: 1 !important; }',
  '@media print {',
  '  .cv-toolbar { display: none !important; }',
  '  .cv-stage { padding: 0; overflow: visible; }',
  '  .cv-shell { position: static; }',
  '  html, body { overflow: visible; }',
  '}',
].join('\n')

const COMPOSITE_VIEWER_SCRIPT = [
  '(function () {',
  '  var shell = document.querySelector(".cv-shell");',
  '  if (!shell) return;',
  '  var fsBtn = shell.querySelector(".cv-fs");',
  '  function toggleFs() {',
  '    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;',
  '    if (!fsEl) {',
  '      var req = shell.requestFullscreen || shell.webkitRequestFullscreen;',
  '      if (req) req.call(shell);',
  '    } else {',
  '      var exit = document.exitFullscreen || document.webkitExitFullscreen;',
  '      if (exit) exit.call(document);',
  '    }',
  '  }',
  '  if (fsBtn) {',
  '    fsBtn.addEventListener("click", toggleFs);',
  '    function fsChange() {',
  '      var on = !!(document.fullscreenElement || document.webkitFullscreenElement);',
  '      fsBtn.textContent = on ? "⛶ 종료" : "⛶ 전체화면";',
  '    }',
  '    document.addEventListener("fullscreenchange", fsChange);',
  '    document.addEventListener("webkitfullscreenchange", fsChange);',
  '  }',
  '  document.addEventListener("keydown", function (e) {',
  '    var t = e.target;',
  '    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;',
  '    if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFs(); }',
  '  });',
  '})();',
].join('\n')
