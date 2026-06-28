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
//   - The cloned root is wrapped in a `.rv-shell` viewer scaffold with
//     a top toolbar (전체 / 슬라이드 / 썸네일 + 전체화면) and a sticky
//     slide-nav footer (◀ / 페이지 N / ▶). Vanilla JS in the same file
//     drives mode switching, keyboard nav, thumb→slide click jumps,
//     and the Fullscreen API. No external dependencies — the file
//     opens offline in any modern browser.
//
// Result: a portable archive of the report that any browser can open
// offline, with the same multi-page navigation the editor offers.

import { apiClient } from '@/shared/api/client'
import { fetchFileBlob } from '@/shared/api/files'
import {
  inlineVideos,
  inlineAttachments,
  inlineDocs,
  inlineEmbeds,
} from './htmlInlineAssets'

export async function exportReportToHtml({ draft, onProgress, signal, staticDoc = false }) {
  // Progress reporter — caller-supplied (ReportDetailPage) drives the
  // ExportOverlay spinner / phase label / page-capture bar. We pass
  // `noop` when unset so call sites don`t need to guard each emit.
  const report = typeof onProgress === 'function' ? onProgress : () => {}
  // Cancellation hook — caller passes an AbortSignal tied to the
  // overlay`s 취소 button. We poll at every step between awaits so
  // the user gets near-instant feedback (`AbortError` thrown → handler
  // skips the failure toast and shows a "취소됨" notice instead).
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
  }
  throwIfAborted()
  const sourceRoot = document.querySelector('.report-detail-root')
  if (!sourceRoot) {
    throw new Error('보고서 영역(.report-detail-root)을 찾을 수 없습니다.')
  }

  // Capture each Plotly graph's spec (traces + layout JSON) from the
  // LIVE DOM. We later inline the plotly.min.js bundle and a small init
  // script so the saved file rebuilds each chart with full Plotly
  // interactivity (zoom, pan, hover tooltips, 3D rotation). The static
  // canvas snapshot path below still runs as a fallback for non-Plotly
  // canvases. Containers are tagged with `data-plotly-export-idx` so
  // the clone consumer can find each twin.
  report({ phase: 'snapshot', label: '차트 / 캔버스 스냅샷 중...' })
  // 정적 문서 모드에선 인터랙티브 Plotly 재렌더 경로를 쓰지 않는다 — 2D 차트는
  // 클론에 렌더된 SVG 가 그대로 남고, 3D/WebGL 은 아래 canvas 스냅샷이 PNG 로
  // 박는다. 그래서 스펙 수집(=재렌더용)을 건너뛴다.
  const plotlySpecs = staticDoc ? [] : snapshotPlotlyCharts(sourceRoot)

  // cad_3d(three.js) 위젯의 file_id / 확장자 / 저장된 카메라(view_state)를 라이브
  // DOM 에서 수집. 인터랙티브 모드에선 아래에서 모델 바이트 + three 번들을
  // 인라인해 저장 파일에서도 회전/확대가 되게 한다. 정적 모드는 canvas PNG
  // 스냅샷(아래)을 그대로 쓰므로 수집을 건너뛴다.
  const cad3dSpecs = staticDoc ? [] : snapshotCad3d(sourceRoot)

  // Snapshot every live <canvas> as a PNG dataURL BEFORE cloning —
  // cloneNode does not preserve canvas pixel buffers (the cloned canvas
  // comes back blank). Scatter3D + any other Plotly 3D / WebGL widget
  // would otherwise save as empty boxes. We index by document order so
  // the clone consumer can replace each canvas by position. Failures
  // (cross-origin tainted canvas — rare here since Plotly draws from
  // local data) leave the cloned canvas untouched rather than aborting.
  const canvasSnapshots = snapshotCanvases(sourceRoot)

  // html2canvas each .report-detail-page off the LIVE DOM to populate
  // the static page-browse panel (the "펼치기" toggle's content) with
  // baked-in thumbnails. Done before cloning because canvas pixel
  // buffers + chart libs are alive only on the source DOM. Sequential
  // capture (plotly WebGL contexts contend in parallel) takes ~300ms
  // per page; for typical 5–20 page reports total is well under the
  // export latency users already accept.
  // 페이지 썸네일은 인터랙티브 뷰어의 "펼치기" 브라우즈 패널 전용이다. 정적
  // 문서 모드엔 그 패널이 없으므로 캡처를 생략(시간 절약).
  const pageThumbnails = staticDoc
    ? []
    : await capturePageThumbnails(sourceRoot, report, signal)
  throwIfAborted()

  // Measure each live RGL grid's rendered width BEFORE cloning. RGL does
  // NOT always write the container width to inline `style.width` (here it
  // only sets `height`), so the cloned grid has no width and stretches to
  // the full viewport in the saved file — while its position:absolute
  // cells stay at their authored left offsets, leaving the right side
  // empty (the "내용이 좌측에 붙고 우측이 빔" symptom). We bake this
  // measured width onto the clone below so the grid keeps its authored
  // size and can be centered. Indexed by document order (clone preserves
  // order).
  const liveGridWidths = Array.from(
    sourceRoot.querySelectorAll('.react-grid-layout'),
  ).map((g) => Math.round(g.getBoundingClientRect().width))

  // Work on a clone so we can strip chrome / inline images without
  // affecting the live DOM the user is still looking at.
  const clone = sourceRoot.cloneNode(true)

  // Remove the live-DOM annotations we left for matching; they served
  // their purpose during the cloneNode() pass above. Doing this now
  // (before any await that might let the user interact with the page)
  // keeps the editor UI from carrying stray attributes.
  clearLivePlotlyAnnotations(sourceRoot)
  clearLiveCad3dAnnotations(sourceRoot)

  // Replace cloned canvases with <img> tags using the live snapshots —
  // must run before any other clone manipulation so subsequent
  // querySelectorAll('img') passes (inlineImages) see the new <img>.
  replaceClonedCanvases(clone, canvasSnapshots)

  // Convert each Plotly container in the clone into an empty placeholder
  // tagged with `data-plotly-spec-id`. The inlined init script (added
  // later in the body) finds these and calls Plotly.newPlot() to
  // reanimate the chart. This OVERWRITES any canvas-img fallback that
  // replaceClonedCanvases just inserted inside Plotly containers —
  // intentionally, since we want the live re-render.
  // 정적 모드는 차트를 비우지 않는다 — 비우면(JS 재렌더 전제) 스크립트 없는
  // 파일에서 영영 빈 박스가 된다. 클론에 남은 렌더 결과(SVG/PNG)를 그대로 둔다.
  if (!staticDoc) prepareClonedPlotlyPlaceholders(clone, plotlySpecs)
  const hasPlotly = !staticDoc && plotlySpecs.some((s) => s != null)

  // cad_3d: 클론의 캔버스-PNG(위 replaceClonedCanvases 결과) 자리를 빈 뷰어
  // 컨테이너로 바꾼다. 정적 모드는 손대지 않아 PNG 가 그대로 남는다.
  if (!staticDoc) prepareClonedCad3d(clone, cad3dSpecs)
  const hasCad3d = !staticDoc && cad3dSpecs.some((s) => s != null)

  // Pin each cloned grid to its live-measured width and center it. The
  // grid items are position:absolute (no intrinsic width), so without a
  // fixed width the grid stretches to the viewport and the content hugs
  // the left. Inline width+maxWidth freeze the authored size; inline
  // `margin: 0 auto` centers the grid within its full-width page card.
  // All inline so it holds regardless of CSS cascade / build state.
  bakeGridWidths(clone, liveGridWidths)

  // The editor's `.report-detail-content` carries an inline
  // `maxWidth: page_width_px` (the user's saved width preference)
  // plus `mx-auto`. Both are editor-only chrome that doesn't
  // translate to the exported file — and they caused the
  // "container too narrow → cards overflow" / "container too wide →
  // blank strip" symptoms. Easiest fix: dissolve the wrapper out of
  // the layout entirely. Page sections become direct flow children of
  // the rv-stage, sized purely by the min-width baked from each grid.
  dissolveContentContainer(clone)

  // The comment side panel (right column) is a sibling of the main
  // content column inside .report-detail-root. When open it forces the
  // grid to bake a narrower width — and worse, the panel UI itself
  // would be cloned into the saved file. Strip it now so the exported
  // archive is just the report, never the reviewer chrome.
  clone
    .querySelectorAll('[data-comment-panel-root]')
    .forEach((el) => el.remove())

  // After the polling in handleExportHtml, the live DOM should have no
  // "크기 조정 중…" placeholders. But the 200ms ResizeObserver debounce
  // in each chart can re-arm at any time (e.g. a final reflow when a
  // sibling card finishes measuring), so a tail can sneak into the
  // clone. The saved file has no React, so the placeholder would stay
  // forever. Find any survivors and replace their text with empty —
  // better an empty box than a fake "still resizing" label.
  scrubResizingPlaceholders(clone)

  // Strip the parts of the screen that aren't the report itself.
  // Annotation edit chrome (style bar, label editor input) only
  // mounts in editor mode — listed here defensively so even if the
  // caller forgets to flip into printing mode, the saved file stays
  // clean of UI controls. Annotation SHAPES (vlines, ranges, points,
  // …) are plain SVG inside the report DOM, so they're captured
  // automatically and don't need special handling here.
  //
  // `.report-detail-pagestrip` (page chips + 펼치기/접기 toggle) is
  // intentionally KEPT — it gives the saved file inline tab-style
  // navigation between pages. Chip clicks get wired to the viewer's
  // goTo() by VIEWER_SCRIPT via [data-page-chip-idx] below.
  //
  // The React-rendered PageBrowsePanel (the visible card grid + its
  // offscreen html2canvas surface) is stripped: it depends on React
  // state for filtering / capture-progress, and we replace it with a
  // static panel below containing pre-rendered thumbnails.
  //
  // [data-export-exclude] marks phase / author-lock banners ("리뷰
  // 진행 중", "발행됨", "수정 잠금") — they describe transient
  // editor state irrelevant to a portable archive.
  clone
    .querySelectorAll(
      '[data-export-exclude], [data-export-overlay], .report-detail-toolbar, .report-detail-floating, .report-autofit-mirror, .annotation-style-bar, .annotation-label-editor',
    )
    .forEach((el) => el.remove())
  // React PageBrowsePanel siblings (visible panel + offscreen capture).
  // Identified by descendants that only exist there: the `data-thumb-page`
  // attribute on the offscreen surface, and the `border-t bg-card` panel
  // root sandwiched between the strip's chip row and the offscreen
  // surface. Removing siblings of the same parent is simplest by walking
  // up from the offscreen surface.
  removeReactBrowsePanel(clone)
  // Replace it with the static panel that the viewer JS can drive.
  // 정적 문서 모드엔 뷰어 JS 가 없으므로 패널을 주입하지 않는다(아래에서
  // 페이지 칩 스트립도 통째로 제거).
  if (!staticDoc) injectStaticBrowsePanel(clone, draft, pageThumbnails)
  // ProseMirror leaves `contenteditable=""` everywhere; harmless for a
  // static viewer but distracting if the file is ever inspected, so
  // strip those + a couple of common a11y artefacts.
  clone.querySelectorAll('[contenteditable]').forEach((el) => {
    el.removeAttribute('contenteditable')
  })
  clone.querySelectorAll('[role="textbox"]').forEach((el) => {
    el.removeAttribute('role')
  })

  const title = draft?.title || '(제목 없음)'
  const date = draft?.report_date || ''

  // Inline every reachable <img> as a data URI so the file is fully
  // portable. Same-origin /api/files/... assets need the bearer
  // token, which apiClient adds automatically.
  report({ phase: 'images', label: '이미지 인라인 중...' })
  throwIfAborted()
  await inlineImages(clone)
  throwIfAborted()

  // 동영상 / 첨부파일 / HTML임베드 번들 자산 굽기. 이들은 런타임 blob URL·
  // JS 인증 fetch·서버 상대경로에 의존해서, 굽지 않으면 저장 파일에서 깨진다
  // (빈 동영상 박스, 죽은 다운로드 버튼, 404 iframe). 인터랙티브·정적 모드
  // 양쪽에서 동작하도록 staticDoc 분기 이전에 처리한다. (htmlInlineAssets.js)
  report({ phase: 'images', label: '동영상 / 첨부 인라인 중...' })
  await inlineVideos(clone)
  throwIfAborted()
  await inlineAttachments(clone)
  throwIfAborted()
  await inlineDocs(clone)
  throwIfAborted()
  await inlineEmbeds(clone)
  throwIfAborted()

  // ─── 정적 문서 모드 ───────────────────────────────────────────────
  // 스크립트가 전혀 없는 단일 HTML: 페이지를 위→아래로 그대로 쌓고, 차트는
  // 클론에 남은 렌더 결과(2D=SVG, 3D=PNG)를 그대로 보여준다. 모바일 메일
  // 첨부처럼 인라인 JS 가 실행되지 않는 환경에서도 그냥 문서로 열린다.
  if (staticDoc) {
    // 페이지 칩 스트립(JS 내비) 은 스크립트 없이는 무의미 — 통째로 제거.
    clone.querySelector('.report-detail-pagestrip')?.remove()

    // 그리드(절대배치/transform)를 블록 흐름으로 풀어, CSS 를 적극 제거하는
    // 메일 뷰어(Knox Portal 등)에서도 위젯이 겹치지 않게 한다.
    linearizeGridsForStatic(clone)

    report({ phase: 'css', label: '스타일 수집 중...' })
    const cssStatic = await collectAllStylesheets()
    throwIfAborted()

    const staticWrap = buildStaticDoc({ clone, title, date })
    const htmlClassAttrStatic = document.documentElement.className
      ? ` class="${escapeAttr(document.documentElement.className)}"`
      : ''
    const colorSchemeStatic = document.documentElement.style.colorScheme || ''

    const htmlStatic =
      '<!DOCTYPE html>\n<html lang="ko"' +
      htmlClassAttrStatic +
      '>\n<head>\n' +
      '<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' +
      escapeHtml(title) +
      '</title>\n' +
      (colorSchemeStatic
        ? '<meta name="color-scheme" content="' +
          escapeAttr(colorSchemeStatic) +
          '">\n'
        : '') +
      '<style>\n' +
      cssStatic +
      '\n</style>\n' +
      '<style data-source="report-html-static">\n' +
      STATIC_OVERRIDES +
      '\n</style>\n' +
      '</head>\n' +
      '<body style="margin:0;background:#f4f4f5;">\n' +
      staticWrap.outerHTML +
      '\n</body>\n</html>\n'

    throwIfAborted()
    report({ phase: 'finalize', label: '파일 생성 중...' })
    const blobStatic = new Blob([htmlStatic], {
      type: 'text/html;charset=utf-8',
    })
    const filenameStatic =
      sanitizeFileName(title) +
      '-' +
      new Date().toISOString().slice(0, 10) +
      '-static.html'
    triggerDownload(blobStatic, filenameStatic)
    return
  }

  // Wrap the cloned report in the standalone viewer scaffold (toolbar +
  // slide nav). The title moves into the toolbar — no separate
  // titleBlock — so a viewer in any mode always sees what report they're
  // looking at. Page count drives whether the slide mode is exposed in
  // the toolbar (single-page reports get a simpler chrome).
  const pageCount = clone.querySelectorAll('.report-detail-page').length
  const viewerShell = buildViewerShell({ clone, title, date, pageCount })

  // Pull in every stylesheet currently affecting the page.
  report({ phase: 'css', label: '스타일 수집 중...' })
  const css = await collectAllStylesheets()
  throwIfAborted()

  // Lazy-load the minified Plotly bundle ONLY when a Plotly widget is
  // present in this report. Vite turns the `?raw` import into a separate
  // chunk so the editor's main bundle is untouched. ~4.7 MB raw / ~1 MB
  // gzip — heavy enough that we don't want to pay it on every export.
  let plotlyJs = ''
  let plotlySpecsJson = ''
  if (hasPlotly) {
    report({ phase: 'plotly', label: 'Plotly 라이브러리 인라인 (~1MB)...' })
    try {
      const mod = await import('plotly.js-dist-min/plotly.min.js?raw')
      throwIfAborted()
      plotlyJs = mod.default || mod
      // Carry the captured live size through to the viewer init script
      // so it can pin layout.width / layout.height instead of letting
      // Plotly measure a possibly-still-settling container. Renaming
      // `_exportSize` → `exportSize` so the JSON is clean public API
      // for the viewer.
      const exportable = plotlySpecs.map((s) => {
        if (!s) return null
        return {
          data: s.data,
          layout: s.layout,
          exportSize: s._exportSize ?? null,
        }
      })
      plotlySpecsJson = JSON.stringify(exportable)
    } catch (err) {
      console.warn('[html-export] plotly inline failed — charts will be static', err)
      // Clear the placeholders so they fall back to whatever static
      // content the clone had (canvas-img or SVG).
      viewerShell.querySelectorAll('[data-plotly-spec-id]').forEach((el) => {
        el.removeAttribute('data-plotly-spec-id')
      })
    }
  }

  // cad_3d 인터랙티브 자산: three+로더 번들(?raw)을 한 번 인라인하고, 각 모델
  // 파일 바이트를 base64 로 받아 spec(id→{dataB64,ext,viewState})에 담는다.
  // 같은 file_id 는 한 번만 받아 재사용. 실패 시 해당 컨테이너의 spec-id 를 떼어
  // 정적 PNG(이미 클론에 없으니 빈 박스)…가 아니라, 안전하게 placeholder 를
  // 비워두기보다 마커만 제거해 빈 컨테이너로 남긴다.
  let cad3dJs = ''
  let cad3dSpecsJson = ''
  if (hasCad3d) {
    report({ phase: 'plotly', label: '3D 모델 / three.js 인라인...' })
    try {
      const mod = await import('./cad3d/viewerRuntime.bundle.js?raw')
      throwIfAborted()
      cad3dJs = mod.default || mod
      const blobCache = new Map() // file_id → base64 (중복 모델 1회만 fetch)
      const specsById = {}
      for (let idx = 0; idx < cad3dSpecs.length; idx += 1) {
        const s = cad3dSpecs[idx]
        if (!s || !s.fileId) continue
        let dataB64 = blobCache.get(s.fileId)
        if (dataB64 == null) {
          try {
            const blob = await fetchFileBlob(s.fileId)
            throwIfAborted()
            dataB64 = arrayBufferToBase64(await blob.arrayBuffer())
            blobCache.set(s.fileId, dataB64)
          } catch (err) {
            console.warn('[html-export] cad_3d model fetch failed', s.fileId, err)
            continue
          }
        }
        specsById[String(idx)] = {
          dataB64,
          ext: s.ext,
          viewState: s.viewState ?? null,
          hiddenParts: s.hiddenParts ?? [],
          wireframeParts: s.wireframeParts ?? [],
        }
      }
      cad3dSpecsJson = JSON.stringify(specsById)
      // 받지 못한(spec 없는) 컨테이너의 마커는 떼서 init 대상에서 제외.
      viewerShell.querySelectorAll('[data-cad3d-spec-id]').forEach((el) => {
        if (!(el.getAttribute('data-cad3d-spec-id') in specsById)) {
          el.removeAttribute('data-cad3d-spec-id')
        }
      })
    } catch (err) {
      console.warn('[html-export] cad_3d runtime inline failed', err)
      viewerShell.querySelectorAll('[data-cad3d-spec-id]').forEach((el) => {
        el.removeAttribute('data-cad3d-spec-id')
      })
    }
  }

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
    // Radix Viewport wraps its content in an inner div styled
    // `display:table; min-width:100%` (for scroll-size measurement). That
    // table formatting context swallows the page cards' margin:auto, so
    // centering breaks (cards drift to one side). Flatten it to a plain
    // full-width block so the centered .report-detail-page cards below
    // lay out predictably.
    '.report-detail-root [data-radix-scroll-area-viewport] > * {',
    '  display: block !important;',
    '  min-width: 0 !important;',
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
    // Page-strip is now a direct flex child of `.rv-shell` (lifted
    // out of `.rv-stage` by buildViewerShell). It sits flush below
    // the toolbar — no sticky positioning needed, no gap from the
    // stage`s top padding. `flex: 0 0 auto` so it sizes to content
    // instead of stretching with the stage.
    //
    // `background: #ffffff !important` overrides Tailwind`s
    // `bg-muted/30` (30% opaque) which would otherwise let any
    // ghost layer through. The editor-only gradient overlays at
    // the strip`s left/right edges (`pointer-events-none absolute
    // bg-gradient-…`) are screen-only scroll-affordance hints and
    // would just clutter the header in the viewer.
    '.rv-shell .report-detail-pagestrip {',
    '  flex: 0 0 auto !important;',
    '  background: #ffffff !important;',
    '}',
    '.rv-shell .report-detail-pagestrip > .pointer-events-none {',
    '  display: none !important;',
    '}',
    // Reset every cloned chip to a neutral state. React baked the
    // editor`s "current page" highlight (`bg-primary/10 text-primary
    // border-primary font-medium`) into whichever chip was active at
    // export time — without this reset that chip stays highlighted
    // forever regardless of viewer navigation. The viewer JS then
    // adds `.rv-chip-active` to whichever chip matches the currently
    // viewed page. Selector targets chips inside the strip but NOT
    // inside the browse panel (which has its own active styling).
    '.rv-shell .report-detail-pagestrip [data-page-chip-idx]:not(.rv-browse-card) {',
    '  background: #ffffff !important;',
    '  color: #18181b !important;',
    '  border-color: #e4e4e7 !important;',
    '  font-weight: 400 !important;',
    '  box-shadow: none !important;',
    '}',
    '.rv-shell .report-detail-pagestrip [data-page-chip-idx]:not(.rv-browse-card):hover {',
    '  background: #f4f4f5 !important;',
    '}',
    '.rv-shell .report-detail-pagestrip [data-page-chip-idx]:not(.rv-browse-card).rv-chip-active {',
    '  background: #18181b !important;',
    '  color: #ffffff !important;',
    '  border-color: #18181b !important;',
    '  font-weight: 500 !important;',
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
    // Viewer chrome CSS is emitted last so its `[data-view="thumb"]` /
    // `[data-view="slide"]` overrides win against the exportOverrides
    // baseline (both use !important at the same specificity tier).
    '<style data-source="report-html-viewer">\n' +
    VIEWER_CSS +
    '\n</style>\n' +
    '</head>\n' +
    '<body style="margin:0;background:#f4f4f5;">\n' +
    viewerShell.outerHTML +
    '\n<script>\n' +
    VIEWER_SCRIPT +
    '\n</script>\n' +
    // Plotly assets — only emitted when at least one widget needs them.
    // Order: library (defines window.Plotly) → specs JSON → init script.
    // Specs go in a <script type="application/json"> so the contents
    // never get parsed as code even if user data contains </script>
    // (sanitized via escape below anyway).
    (plotlyJs
      ? '\n<script>\n' + plotlyJs + '\n</script>\n' +
        '<script type="application/json" id="rv-plotly-specs">' +
        escapeScriptJson(plotlySpecsJson) +
        '</script>\n' +
        '<script>\n' + PLOTLY_INIT_SCRIPT + '\n</script>\n'
      : '') +
    // cad_3d 인터랙티브 자산 — three+로더 번들(window.__RA_CAD3D__ 정의) →
    // 모델 spec JSON → init. Plotly 와 동일 패턴.
    (cad3dJs
      ? '\n<script>\n' + cad3dJs + '\n</script>\n' +
        '<script type="application/json" id="rv-cad3d-specs">' +
        escapeScriptJson(cad3dSpecsJson) +
        '</script>\n' +
        '<script>\n' + CAD3D_INIT_SCRIPT + '\n</script>\n'
      : '') +
    '</body>\n</html>\n'

  throwIfAborted()
  report({ phase: 'finalize', label: '파일 생성 중...' })
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
export async function collectAllStylesheets() {
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

// --- RGL grid width propagation -------------------------------------- //
//
// `react-grid-layout` writes the measured container width into the grid
// element's inline style (e.g. `width: 1180px`). Its widget cells use
// position:absolute, so they do NOT contribute to the parent page
// section's intrinsic content width — by default the section stays at
// stage-width while the grid pokes out the right side. Walking the
// clone and copying each grid's `style.width` onto its closest
// `.report-detail-page` as `min-width` makes the page card grow to
// contain the grid. Stage's overflow:auto then handles horizontal
// scroll cleanly with no visual leakage.

function bakeGridWidths(cloneEl, widths) {
  const grids = cloneEl.querySelectorAll('.react-grid-layout')
  grids.forEach((grid, i) => {
    const w = widths[i]
    if (!w || w <= 0) return
    // Freeze the authored width so the grid doesn't stretch to viewport.
    grid.style.width = w + 'px'
    grid.style.maxWidth = w + 'px'
    // Center within the full-width page card.
    grid.style.marginLeft = 'auto'
    grid.style.marginRight = 'auto'
  })
}

// --- Content container dissolve -------------------------------------- //
//
// Editor wraps the pages in `<div .report-detail-content
// style="maxWidth: page_width_px" class="mx-auto p-6 space-y-8">`.
// All three styles are editor-only chrome:
//   - maxWidth enforces the user's width preference *against the
//     editor viewport*, which has nothing to do with the captured
//     grid widths. Carrying it through made the saved file either
//     overflow (when narrower than the page card) or leave a blank
//     strip (when wider).
//   - mx-auto centers the column; the export viewer anchors content
//     left so wide reports don't push off-screen.
//   - p-6 and space-y-8 just add padding/gaps the viewer's own
//     stage padding + viewer-CSS card margins already handle.
//
// Easiest: dissolve the wrapper from layout entirely (`display:
// contents`). The page sections inside become direct flow children
// of the rv-stage's scroll area, sized purely by each grid's baked
// min-width. No leftover width constraint, no overflow.
//
// SlideGuideOverlay also lives inside this container — it positions
// itself with inset:0 against the wrapper. With `display: contents`
// it would re-anchor to whatever ancestor IS positioned (the
// rv-stage) and draw across the whole viewport. We strip it
// defensively since it's a screen-only editing guide anyway.

function dissolveContentContainer(cloneEl) {
  const contentEl = cloneEl.querySelector('.report-detail-content')
  if (!contentEl) return
  contentEl
    .querySelectorAll('[data-slide-guide-overlay]')
    .forEach((el) => el.remove())
  contentEl.style.display = 'contents'
  // Also unset the inline maxWidth so even fallback layouts that
  // don't honor display:contents (very old engines) at least don't
  // mis-clip the cards.
  contentEl.style.maxWidth = 'none'
}

// --- Page-thumbnail capture + static browse panel -------------------- //
//
// The editor's PageStrip exposes a "펼치기" toggle that opens a
// PageBrowsePanel — a thumbnail grid of every page with a search box.
// In the editor it runs html2canvas on an offscreen InlineReportView
// asynchronously; in the saved file we can't run React, so we capture
// here at export time off the LIVE DOM and bake the PNG data URIs into
// a static panel. The cloned 펼치기 toggle then has a real handler
// (VIEWER_SCRIPT, [data-page-strip-toggle]) that flips the static
// panel's `hidden` attr. Card clicks share the same
// [data-page-chip-idx] attribute as the strip's chips so they reuse
// the navigation handler for free.

async function capturePageThumbnails(sourceRoot, report = () => {}, signal) {
  const pages = Array.from(sourceRoot.querySelectorAll('.report-detail-page'))
  if (pages.length === 0) return []
  report({ phase: 'capture', label: 'html2canvas 로드 중...', current: 0, total: pages.length })
  let html2canvas
  try {
    const mod = await import('html2canvas')
    html2canvas = mod.default || mod
  } catch (err) {
    console.warn('[html-export] html2canvas load failed — browse panel will be text-only', err)
    return pages.map(() => null)
  }
  const TARGET_WIDTH = 360
  const out = []
  // Sequential — Plotly WebGL contexts contend in parallel and html2canvas
  // reads pixels through getImageData which serializes anyway. The same
  // tradeoff PageBrowsePanel makes in the editor.
  for (let i = 0; i < pages.length; i++) {
    // Check abort BEFORE each capture — the longest blocking call in
    // the export, so polling here gives the cancel button its most
    // responsive surface.
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
    const page = pages[i]
    report({
      phase: 'capture',
      label: '페이지 썸네일 생성 중',
      current: i,
      total: pages.length,
    })
    try {
      const w = page.getBoundingClientRect().width || 1
      // Scale = target / actual; clamp so a tiny page doesn't render at
      // huge resolution and a huge page stays readable. The thumbnail is
      // a preview, not a faithful reproduction — 360 CSS-px wide reads
      // nicely in a 200px card slot at 2x density.
      const scale = Math.max(0.15, Math.min(1, TARGET_WIDTH / w))
      const canvas = await html2canvas(page, {
        scale,
        backgroundColor: '#ffffff',
        logging: false,
        useCORS: true,
        // The ExportOverlay spinner is `position: fixed; inset: 0`
        // and stacks above the page during capture. html2canvas
        // walks the DOM including stacked fixed elements, so without
        // this filter every thumbnail would bake "HTML 파일로 저장
        // 중 / 페이지 썸네일 생성 중 N/M" into its image. The marker
        // attribute lives on the overlay root in ReportDetailPage.
        ignoreElements: (el) =>
          el && el.hasAttribute && el.hasAttribute('data-export-overlay'),
      })
      out.push(canvas.toDataURL('image/png'))
    } catch (err) {
      console.warn('[html-export] page thumbnail capture failed', err)
      out.push(null)
    }
  }
  report({ phase: 'capture', label: '페이지 썸네일 완료', current: pages.length, total: pages.length })
  return out
}

function removeReactBrowsePanel(cloneEl) {
  // Offscreen capture surface — its only stable signal is
  // [data-thumb-page]. Walk up to the wrapper div PageBrowsePanel
  // returned as its fragment's second child, then also strip the
  // visible panel which is the same wrapper's preceding sibling.
  const offscreenAnchor = cloneEl.querySelector('[data-thumb-page]')
  if (offscreenAnchor) {
    // Climb until we find the container that's a direct child of the
    // pagestrip. Both the visible panel root and the offscreen surface
    // are siblings at that level.
    let cur = offscreenAnchor
    while (cur && cur.parentElement && !cur.parentElement.classList.contains('report-detail-pagestrip')) {
      cur = cur.parentElement
    }
    if (cur) {
      const visiblePanel = cur.previousElementSibling
      if (visiblePanel) visiblePanel.remove()
      cur.remove()
    }
  }
}

function injectStaticBrowsePanel(cloneEl, draft, thumbnails) {
  const pagestrip = cloneEl.querySelector('.report-detail-pagestrip')
  if (!pagestrip) return
  const pages = Array.isArray(draft?.pages) ? draft.pages : []
  // Edge case: report exists but no pages array (corrupt state) —
  // skip the panel; the toggle still works but opens an empty list.
  if (pages.length === 0) return
  const panel = document.createElement('div')
  panel.setAttribute('data-page-strip-panel', '')
  panel.className = 'rv-browse-panel'
  panel.hidden = true
  const totalStr = String(pages.length)
  const header =
    '<div class="rv-browse-header">' +
      '<input type="text" data-page-browse-query placeholder="페이지 제목 검색" class="rv-browse-search">' +
      '<span class="rv-browse-count" data-page-browse-count>' + totalStr + ' / ' + totalStr + '</span>' +
      '<button type="button" data-page-browse-close class="rv-browse-close" title="닫기">닫기</button>' +
    '</div>'
  let grid = '<div class="rv-browse-grid">'
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]
    const rawName = (typeof p?.name === 'string' && p.name.trim()) ? p.name.trim() : ('페이지 ' + (i + 1))
    const numStr = String(i + 1)
    const thumb = thumbnails[i]
    const search = (rawName + ' ' + numStr).toLowerCase()
    grid +=
      '<button type="button" class="rv-browse-card" data-page-chip-idx="' + i + '"' +
      ' data-search="' + escapeAttr(search) + '">' +
        '<div class="rv-browse-card-label">' +
          '<span class="rv-browse-card-num">' + escapeHtml(numStr) + '</span>' +
          '<span class="rv-browse-card-name">' + escapeHtml(rawName) + '</span>' +
        '</div>' +
        (thumb
          ? '<img src="' + thumb + '" alt="" class="rv-browse-card-thumb">'
          : '<div class="rv-browse-card-thumb-empty">미리보기 없음</div>') +
      '</button>'
  }
  grid += '</div>'
  panel.innerHTML = header + grid
  pagestrip.appendChild(panel)
}

// --- Resize-placeholder scrub ---------------------------------------- //
//
// Chart / Scatter / Heatmap / Box / Treemap / Density / Sankey / Pie /
// Radar / Contour / Scatter3D all render a "크기 조정 중…" placeholder
// for 200ms after their ResizeObserver fires. handleExportHtml polls
// until the live DOM has zero placeholders before cloning, but a
// debounce can re-arm between the all-clear check and the clone (e.g.
// a sibling's late measurement triggers one final reflow). The clone
// has no React to flip `resizing` back, so the placeholder text
// would persist forever in the saved file.
//
// We can't render the missing chart (the spec lives in React state,
// not the DOM), but emptying the placeholder text turns "크기 조정
// 중…" into a silent empty box — graceful degradation rather than a
// permanent "still computing" lie.

export function scrubResizingPlaceholders(rootEl) {
  const RESIZING_TEXT = '크기 조정 중…'
  rootEl.querySelectorAll('div').forEach((el) => {
    if (el.children.length === 0 && el.textContent?.trim() === RESIZING_TEXT) {
      el.textContent = ''
    }
  })
}

// --- Plotly interactive re-render ------------------------------------ //
//
// Plotly widgets (Scatter3D, Box, Density, Sankey, Pie, Treemap, Heatmap,
// Contour) lose all interactivity when cloned: 2D charts survive as
// static SVG but hover/zoom callbacks are gone; 3D charts come back as
// blank canvases (handled separately by snapshotCanvases as a fallback).
// To restore zoom/pan/hover/rotation in the exported HTML we
//   (a) read each live Plotly container's traces + layout via the
//       public `Plotly.Plots.graphJson(gd)` serializer,
//   (b) annotate the live container so we can match the clone twin,
//   (c) in the clone, swap each container's contents for an empty
//       placeholder tagged with `data-plotly-spec-id`,
//   (d) inline the full minified plotly.js bundle + a tiny init script
//       in the saved file. The script reads the spec JSON, finds each
//       placeholder, and calls `Plotly.newPlot()` — viewer gets full
//       interactivity offline.
//
// Cost: the file gains ~4.7 MB raw (~1 MB gzip) when ≥1 Plotly widget
// exists. If a report has zero Plotly widgets, none of this gets
// emitted and the file stays small.

export function snapshotPlotlyCharts(rootEl) {
  const containers = Array.from(rootEl.querySelectorAll('.js-plotly-plot'))
  const specs = []
  containers.forEach((el, idx) => {
    let spec = null
    const rect = el.getBoundingClientRect()
    try {
      // Public API — returns a JSON-serializable {data, layout} string.
      if (window.Plotly?.Plots?.graphJson) {
        spec = JSON.parse(window.Plotly.Plots.graphJson(el))
      } else if (el.data && el.layout) {
        // Fallback: round-trip through JSON to drop circular refs and
        // any function/DOM-node decorations Plotly attaches.
        spec = {
          data: JSON.parse(JSON.stringify(el.data)),
          layout: JSON.parse(JSON.stringify(el.layout)),
        }
      }
    } catch (err) {
      console.warn('[html-export] plotly snapshot failed', err)
    }
    if (spec) {
      // Stash live dimensions so the placeholder reserves the same box
      // before Plotly.newPlot fires — avoids layout shift on file open.
      spec._exportSize = {
        width: Math.round(rect.width) || null,
        height: Math.round(rect.height) || null,
      }
    }
    specs.push(spec)
    el.setAttribute('data-plotly-export-idx', String(idx))
  })
  return specs
}

export function clearLivePlotlyAnnotations(rootEl) {
  rootEl.querySelectorAll('[data-plotly-export-idx]').forEach((el) => {
    el.removeAttribute('data-plotly-export-idx')
  })
}

export function prepareClonedPlotlyPlaceholders(cloneEl, specs) {
  const containers = Array.from(cloneEl.querySelectorAll('.js-plotly-plot'))
  containers.forEach((el) => {
    const idxAttr = el.getAttribute('data-plotly-export-idx')
    if (idxAttr == null) return
    const idx = parseInt(idxAttr, 10)
    const spec = specs[idx]
    el.removeAttribute('data-plotly-export-idx')
    if (!spec) return
    // Reset the container so Plotly.newPlot has a clean slate.
    el.innerHTML = ''
    el.setAttribute('data-plotly-spec-id', String(idx))
    // Reserve box so paint doesn't jump before newPlot runs.
    if (spec._exportSize?.width) el.style.width = spec._exportSize.width + 'px'
    if (spec._exportSize?.height) el.style.height = spec._exportSize.height + 'px'
  })
}

// Tiny vanilla-JS init: waits for DOM + Plotly to be ready, finds every
// container we tagged, and reanimates it. Each chart gets its own
// try/catch so one bad spec doesn't break the rest.
//
// Sizing strategy: use the captured `exportSize` (live editor`s
// getBoundingClientRect at snapshot time) as the AUTHORITATIVE chart
// dimensions. We bake them into `layout.width` / `layout.height` and
// turn off Plotly`s own resize handler — without this Plotly measures
// the container at init time (often before the surrounding flex /
// grid layout has fully settled) and re-renders the chart at the
// wrong aspect ratio, which surfaces to the user as a squished
// widget that no longer matches what they saw on screen.
//
// Timing: wait for window.load (not DOMContentLoaded). At
// DOMContentLoaded the inline <style> blocks are parsed but their
// rules haven`t been applied to the render tree in some browsers, so
// the container`s bounding box can still be 0 — even though we now
// pass explicit width/height that bypasses container measurement,
// waiting for load is cheap insurance for any future code path that
// does rely on layout.
export const PLOTLY_INIT_SCRIPT = [
  '(function () {',
  '  function init() {',
  '    if (!window.Plotly) return;',
  '    var specsTag = document.getElementById("rv-plotly-specs");',
  '    if (!specsTag) return;',
  '    var specs;',
  '    try { specs = JSON.parse(specsTag.textContent || "[]"); } catch (e) { return; }',
  '    var nodes = document.querySelectorAll("[data-plotly-spec-id]");',
  '    for (var i = 0; i < nodes.length; i++) {',
  '      var el = nodes[i];',
  '      var idx = parseInt(el.getAttribute("data-plotly-spec-id"), 10);',
  '      var spec = specs[idx];',
  '      if (!spec || !spec.data) continue;',
  '      try {',
  '        var layout = Object.assign({}, spec.layout || {});',
  '        // Override layout.width / layout.height with the captured',
  '        // editor-time dimensions. Plotly will draw at those exact',
  '        // pixel sizes and not consult the container box.',
  '        if (spec.exportSize) {',
  '          if (spec.exportSize.width)  layout.width  = spec.exportSize.width;',
  '          if (spec.exportSize.height) layout.height = spec.exportSize.height;',
  '          el.style.width  = spec.exportSize.width  + "px";',
  '          el.style.height = spec.exportSize.height + "px";',
  '        }',
  '        window.Plotly.newPlot(el, spec.data, layout, {',
  '          responsive: false,',
  '          useResizeHandler: false,',
  '          displaylogo: false,',
  '        });',
  '      } catch (e) { console.warn("plotly redraw failed", e); }',
  '    }',
  '  }',
  '  if (document.readyState === "complete") {',
  '    init();',
  '  } else {',
  '    window.addEventListener("load", init);',
  '  }',
  '})();',
].join('\n')

// --- cad_3d (three.js) interactive export ----------------------------- //
//
// cad_3d 위젯은 three.js 가 WebGL <canvas> 에 그린다. 기본 export 는 이 캔버스를
// PNG 로 스냅샷(snapshotCanvases)해 정지 이미지로 박지만, 인터랙티브 모드에선
// 모델 파일 바이트 + 사전 번들한 three 런타임(cad3d/viewerRuntime.bundle.js)을
// 인라인해 저장 파일에서도 회전/확대가 되게 한다. Plotly 경로와 동일한 3단계:
// 라이브 스냅샷 → 클론 placeholder → 번들+spec+init 인라인.

// 라이브 DOM 의 각 cad_3d 컨테이너(Cad3d.jsx 가 data-cad3d-file-id 등을 심음)에서
// file_id / 확장자 / 저장된 카메라(view_state)를 읽고, 문서 순서 인덱스로 태깅한다.
export function snapshotCad3d(rootEl) {
  const nodes = Array.from(rootEl.querySelectorAll('[data-cad3d-file-id]'))
  const specs = []
  nodes.forEach((el, idx) => {
    const fileId = el.getAttribute('data-cad3d-file-id') || null
    const ext = (el.getAttribute('data-cad3d-ext') || '').toLowerCase() || null
    const parseAttrJson = (name) => {
      const raw = el.getAttribute(name)
      if (!raw) return null
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    }
    const viewState = parseAttrJson('data-cad3d-view-state')
    const hiddenParts = parseAttrJson('data-cad3d-hidden-parts')
    const wireframeParts = parseAttrJson('data-cad3d-wireframe-parts')
    const rect = el.getBoundingClientRect()
    specs.push(
      fileId && ext
        ? {
            fileId,
            ext,
            viewState,
            hiddenParts: Array.isArray(hiddenParts) ? hiddenParts : [],
            wireframeParts: Array.isArray(wireframeParts) ? wireframeParts : [],
            width: Math.round(rect.width) || null,
            height: Math.round(rect.height) || null,
          }
        : null,
    )
    el.setAttribute('data-cad3d-export-idx', String(idx))
  })
  return specs
}

export function clearLiveCad3dAnnotations(rootEl) {
  rootEl.querySelectorAll('[data-cad3d-export-idx]').forEach((el) => {
    el.removeAttribute('data-cad3d-export-idx')
  })
}

// 클론에서 각 컨테이너를 비우고(=PNG-img 제거) 뷰어 placeholder 로 만든다.
// 라이브 크기를 inline 으로 박아 파일 열림 직후 박스가 무너지지 않게 한다.
export function prepareClonedCad3d(cloneEl, specs) {
  const nodes = Array.from(cloneEl.querySelectorAll('[data-cad3d-export-idx]'))
  nodes.forEach((el) => {
    const idxAttr = el.getAttribute('data-cad3d-export-idx')
    el.removeAttribute('data-cad3d-export-idx')
    if (idxAttr == null) return
    const idx = parseInt(idxAttr, 10)
    const spec = specs[idx]
    if (!spec) return
    el.innerHTML = '' // 캔버스-PNG / 로딩오버레이 제거
    el.setAttribute('data-cad3d-spec-id', String(idx))
    el.style.position = 'relative'
    if (spec.width) el.style.width = spec.width + 'px'
    if (spec.height) el.style.height = spec.height + 'px'
    if (spec.height) el.style.minHeight = spec.height + 'px'
  })
}

// ArrayBuffer → base64. btoa 는 바이너리 문자열을 받으므로 청크로 끊어
// String.fromCharCode 부담/콜스택 한계를 피한다(대형 모델 대비).
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK),
    )
  }
  return btoa(binary)
}

// 저장 파일 안에서 실행: spec JSON 을 읽어 런타임의 initAll 로 모든 뷰어를 띄운다.
// window.load 후 실행(인라인 <style> 가 적용돼 컨테이너 크기가 잡힌 뒤).
export const CAD3D_INIT_SCRIPT = [
  '(function () {',
  '  function init() {',
  '    if (!window.__RA_CAD3D__) return;',
  '    var tag = document.getElementById("rv-cad3d-specs");',
  '    if (!tag) return;',
  '    var specs;',
  '    try { specs = JSON.parse(tag.textContent || "{}"); } catch (e) { return; }',
  '    try { window.__RA_CAD3D__.initAll(specs); }',
  '    catch (e) { console.warn("cad3d init failed", e); }',
  '  }',
  '  if (document.readyState === "complete") { init(); }',
  '  else { window.addEventListener("load", init); }',
  '})();',
].join('\n')

// --- Canvas snapshotting ---------------------------------------------- //
//
// cloneNode(true) on a <canvas> returns a canvas with the same width/
// height attributes but an empty pixel buffer — every drawing made via
// 2D context or WebGL is lost. For widgets that paint into canvas
// (Plotly's Scatter3D / surface / WebGL fallbacks; any future
// canvas-based viz) we have to capture the live pixels before cloning,
// then swap in <img> tags on the clone side.

export function snapshotCanvases(rootEl) {
  const canvases = Array.from(rootEl.querySelectorAll('canvas'))
  return canvases.map((canvas) => {
    if (!canvas.width || !canvas.height) return null
    try {
      return {
        dataUrl: canvas.toDataURL('image/png'),
        width: canvas.clientWidth || canvas.width,
        height: canvas.clientHeight || canvas.height,
        style: canvas.getAttribute('style') || '',
      }
    } catch (err) {
      // SecurityError on cross-origin tainted canvas — leave it blank
      // rather than failing the entire export. Plotly draws from
      // user-supplied data so this is unlikely to trigger.
      console.warn('[html-export] canvas snapshot failed', err)
      return null
    }
  })
}

export function replaceClonedCanvases(rootClone, snapshots) {
  const clonedCanvases = Array.from(rootClone.querySelectorAll('canvas'))
  for (let i = 0; i < clonedCanvases.length; i++) {
    const snap = snapshots[i]
    const canvas = clonedCanvases[i]
    if (!snap) continue
    const img = document.createElement('img')
    img.src = snap.dataUrl
    if (snap.style) img.setAttribute('style', snap.style)
    img.style.display = 'block'
    img.style.width = snap.width + 'px'
    img.style.height = snap.height + 'px'
    canvas.replaceWith(img)
  }
}

// --- Image inlining --------------------------------------------------- //

export async function inlineImages(rootEl) {
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

// --- Static grid linearization --------------------------------------- //
//
// 보고서 본문은 react-grid-layout 으로 각 위젯을 position:absolute +
// transform:translate(x,y) 로 좌표 배치한다. 이 규칙들은 수집된 <style>
// 블록(클래스 CSS)에 들어가는데, Knox Portal 같은 보안 메일 뷰어는 첨부
// HTML 을 sanitize 하며 <style>/transform/position 을 떨궈버린다. 그러면 모든
// 위젯이 좌상단으로 무너져 "겹쳐 보인다".
//
// 정적 모드에선 그리드를 일반 블록 흐름(읽기 순서대로 세로 1단)으로 풀어
// 이 의존성을 끊는다 — 블록 요소는 스타일이 통째로 사라져도 문서 순서대로
// 위→아래로 쌓이며 절대 겹치지 않는다. 좌표(transform translate / left·top)를
// 읽어 읽기 순서로 DOM 을 재배열하고, 위치 관련 인라인 스타일을 중화한다.
function linearizeGridsForStatic(rootClone) {
  const grids = Array.from(rootClone.querySelectorAll('.react-grid-layout'))
  grids.forEach((grid) => {
    const items = Array.from(grid.children).filter((el) =>
      el.classList?.contains('react-grid-item'),
    )
    if (items.length === 0) return
    const positioned = items.map((el) => {
      let x = 0
      let y = 0
      const m = /translate\(\s*(-?[\d.]+)px[\s,]+(-?[\d.]+)px/.exec(
        el.style.transform || '',
      )
      if (m) {
        x = parseFloat(m[1])
        y = parseFloat(m[2])
      } else {
        x = parseFloat(el.style.left) || 0
        y = parseFloat(el.style.top) || 0
      }
      return { el, x, y }
    })
    // 읽기 순서: 위→아래, 같은 행(24px 허용오차)이면 왼→오른.
    positioned.sort((a, b) =>
      Math.abs(a.y - b.y) > 24 ? a.y - b.y : a.x - b.x,
    )
    positioned.forEach(({ el }) => {
      // 위치 의존(절대배치/변환) 제거 — 인라인이라 <style> 가 떨궈져도 유지.
      el.style.position = 'static'
      el.style.transform = 'none'
      el.style.left = 'auto'
      el.style.top = 'auto'
      el.style.width = '100%'
      el.style.maxWidth = '100%'
      el.style.height = 'auto'
      el.style.margin = '0 0 16px 0'
      el.style.boxSizing = 'border-box'
      grid.appendChild(el) // DOM 순서를 읽기 순서로 재배열
    })
    grid.style.position = 'static'
    grid.style.height = 'auto'
    grid.style.width = '100%'
  })
  // 이미지가 좁은 화면을 넘지 않도록 인라인으로 캡(스타일시트 제거 환경 대비).
  rootClone.querySelectorAll('.react-grid-layout img').forEach((img) => {
    img.style.maxWidth = '100%'
    img.style.height = 'auto'
  })
}

// --- Static document scaffold ---------------------------------------- //
//
// 정적(no-JS) 문서용 래퍼. 뷰어 쉘(.rv-shell, 툴바/슬라이드 내비)과 달리
// 스크립트가 없으므로 페이지를 위→아래로 그대로 쌓고 제목 헤더만 올린다.
// 모바일 메일 첨부처럼 인라인 JS 가 안 도는 환경에서도 평범한 문서로 열린다.
function buildStaticDoc({ clone, title, date }) {
  const wrap = document.createElement('div')
  wrap.className = 'rv-static'
  const header = document.createElement('header')
  header.className = 'rv-static-header'
  header.innerHTML =
    '<h1>' +
    escapeHtml(title) +
    '</h1>' +
    (date ? '<div class="rv-static-date">' + escapeHtml(date) + '</div>' : '')
  wrap.appendChild(header)
  wrap.appendChild(clone)
  return wrap
}

// 정적 문서 전용 CSS 오버라이드. 앞부분은 인터랙티브 export 와 동일한 root
// 평탄화(앱-쉘 flex / Radix ScrollArea 를 일반 블록 흐름으로 풀어 모든 페이지가
// 보이게) 이고, 뒷부분은 .rv-static 래퍼 + 페이지 카드 중앙정렬뿐이다. rv-shell
// /pagestrip 관련 규칙은 정적 모드엔 해당 요소가 없으므로 뺐다.
const STATIC_OVERRIDES = [
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
  '.report-detail-root [data-radix-scroll-area-viewport],',
  '.report-detail-root [data-radix-scroll-area-root] {',
  '  height: auto !important;',
  '  max-height: none !important;',
  '  overflow: visible !important;',
  '  width: 100% !important;',
  '}',
  '.report-detail-root [data-radix-scroll-area-viewport] > * {',
  '  display: block !important;',
  '  min-width: 0 !important;',
  '  width: 100% !important;',
  '}',
  '.report-detail-root .mx-auto {',
  '  margin-left: 0 !important;',
  '  margin-right: 0 !important;',
  '}',
  '.report-detail-root .max-w-5xl {',
  '  max-width: none !important;',
  '}',
  // 정적 래퍼 — 가운데 정렬된 문서 폭 + 제목 헤더.
  '.rv-static {',
  '  max-width: 1100px;',
  '  margin: 0 auto;',
  '  padding: 24px 16px 64px;',
  '  box-sizing: border-box;',
  '}',
  '.rv-static-header {',
  '  padding: 4px 4px 16px;',
  '  margin-bottom: 20px;',
  '  border-bottom: 1px solid #e4e4e7;',
  '}',
  '.rv-static-header h1 {',
  '  margin: 0;',
  '  font-size: 20px;',
  '  font-weight: 700;',
  '  line-height: 1.3;',
  '  color: #18181b;',
  '}',
  '.rv-static-date {',
  '  margin-top: 4px;',
  '  font-size: 12px;',
  '  color: #71717a;',
  '}',
  // 페이지 카드 — 인터랙티브 "전체" 모드(.rv-shell[data-view="all"])의 카드
  // 스타일을 .rv-static 로 옮겨온 것. 뷰어 CSS 가 없는 정적 모드에서도 흰
  // 카드·테두리·그림자가 그대로 나오고, 그리드가 카드 안에서 중앙정렬된다.
  '.rv-static .report-detail-page {',
  '  box-sizing: content-box !important;',
  '  margin: 0 auto 24px !important;',
  '  padding: 24px 28px;',
  '  background: #ffffff;',
  '  border: 1px solid #e5e7eb;',
  '  border-radius: 8px;',
  '  box-shadow: 0 1px 3px rgba(0,0,0,0.03);',
  '}',
  // RGL 그리드는 고정 px 폭 + position:absolute 셀이라 기본은 좌측에 붙는다.
  // auto 좌우 마진으로 카드 안에서 가운데로 — 내용 중앙정렬의 실제 레버.
  '.rv-static .report-detail-page .react-grid-layout {',
  '  margin-left: auto !important;',
  '  margin-right: auto !important;',
  '}',
].join('\n')

// --- Viewer scaffold ------------------------------------------------- //
//
// The exported HTML wraps the cloned report in a `.rv-shell` viewer:
//
//   <div class="rv-shell" data-view="all" data-pages="N">
//     <header class="rv-toolbar">제목 · 모드 토글 · 전체화면</header>
//     <div class="rv-stage">…clone…</div>
//     <footer class="rv-slidenav" hidden>◀ / N · M / ▶</footer>
//   </div>
//
// Two view modes:
//   - all   : every page stacked (the original export behavior)
//   - slide : one page visible at a time, prev/next + page indicator
//
// (A thumbnail-grid mode used to live here too. It was superseded by
// the kept-from-editor page strip + 펼치기/접기 browse panel which
// already gives the same overview-and-jump UX inline with the report
// chrome — no need for a duplicate viewer-only mode.)
//
// The slide-nav footer is sticky and only mounted in slide mode (JS
// toggles the `hidden` attr). All buttons get keyboard equivalents
// (←/→/Home/End for page nav, Ctrl+1/2 for mode switch, F for
// fullscreen) so a viewer can drive the whole experience without a
// mouse.

function buildViewerShell({ clone, title, date, pageCount }) {
  const shell = document.createElement('div')
  shell.className = 'rv-shell'
  shell.setAttribute('data-view', 'all')
  shell.setAttribute('data-pages', String(pageCount))

  const titleText =
    escapeHtml(title) + (date ? ' <span class="rv-date">· ' + escapeHtml(date) + '</span>' : '')

  // Toolbar — top, sticky. Mode buttons get explicit tooltips with
  // keyboard shortcuts so power users discover them. Single-page
  // reports auto-hide the slide/thumb buttons via CSS rule on
  // `[data-pages="1"]`.
  const toolbar = document.createElement('header')
  toolbar.className = 'rv-toolbar'
  toolbar.innerHTML =
    '<div class="rv-title">' + titleText + '</div>' +
    '<div class="rv-modes" role="tablist" aria-label="보기 모드">' +
      '<button type="button" data-mode="all" aria-pressed="true" title="모든 페이지를 한 번에 (Ctrl+1)">전체</button>' +
      '<button type="button" data-mode="slide" title="페이지별 보기 (Ctrl+2, ←/→)">슬라이드</button>' +
    '</div>' +
    '<button type="button" class="rv-fs" title="전체화면 토글 (F)" aria-label="전체화면">⛶ 전체화면</button>'

  // Stage holds the cloned report root. clone is moved (not copied) —
  // caller already discarded the live DOM reference.
  const stage = document.createElement('div')
  stage.className = 'rv-stage'
  stage.appendChild(clone)

  // Lift the page-strip out of the cloned report tree and into the
  // shell chrome — sits between toolbar and stage so it visually
  // attaches to the header instead of floating with a gap above its
  // former sticky position (rv-stage`s 16px top padding used to show
  // between the toolbar bottom and the sticky strip top in 전체 mode).
  // As a regular flex child of `.rv-shell` it sits flush below the
  // toolbar; no sticky-positioning quirks, no stacking-context issues.
  // Browse panel was appended INTO the strip by injectStaticBrowsePanel
  // so it moves with it as one unit.
  const pageStripEl = clone.querySelector('.report-detail-pagestrip')

  // Slide nav — sticky bottom, hidden in non-slide modes. Page indicator
  // gets updated by the viewer script as currentIdx changes.
  const slideNav = document.createElement('footer')
  slideNav.className = 'rv-slidenav'
  slideNav.hidden = true
  slideNav.innerHTML =
    '<button type="button" class="rv-prev" title="이전 페이지 (←)" aria-label="이전 페이지">◀</button>' +
    '<div class="rv-pageinfo"><span class="rv-pagenow">1</span> / <span class="rv-pagetotal">' +
      String(pageCount || 1) +
    '</span></div>' +
    '<button type="button" class="rv-next" title="다음 페이지 (→)" aria-label="다음 페이지">▶</button>'

  shell.appendChild(toolbar)
  if (pageStripEl) shell.appendChild(pageStripEl)
  shell.appendChild(stage)
  shell.appendChild(slideNav)
  return shell
}

// CSS for the viewer chrome + per-mode layout. Plain CSS so the file
// doesn't need Tailwind in the export. Mode-specific rules go last so
// they win the cascade against the export-overrides block (both layers
// use !important at equal specificity).
const VIEWER_CSS = [
  '/* ───── Viewer shell ─────',
  '   Layout: shell is exactly viewport-tall; toolbar/footer are fixed',
  '   blocks at top/bottom; only the stage scrolls internally. This',
  '   keeps toolbar visible regardless of content width and avoids the',
  '   sticky-positioning quirks that surfaced with wide grids + small',
  '   viewports. */',
  'html, body { background: #f4f4f5; margin: 0; padding: 0; overflow: hidden; height: 100%; }',
  '.rv-shell {',
  '  position: fixed;',
  '  inset: 0;',
  '  display: flex;',
  '  flex-direction: column;',
  '  background: #f4f4f5;',
  '  overflow: hidden;  /* clip anything that tries to leak past viewport */',
  '}',
  '.rv-shell:fullscreen { background: #f4f4f5; }',
  '',
  '/* Toolbar */',
  '.rv-toolbar {',
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
  '.rv-title {',
  '  flex: 1;',
  '  min-width: 0;',
  '  font-size: 13px;',
  '  font-weight: 600;',
  '  color: #18181b;',
  '  overflow: hidden;',
  '  text-overflow: ellipsis;',
  '  white-space: nowrap;',
  '}',
  '.rv-date { color: #71717a; font-weight: 400; margin-left: 4px; }',
  '.rv-modes { display: flex; gap: 4px; flex-shrink: 0; }',
  '.rv-modes button, .rv-fs {',
  '  padding: 5px 11px;',
  '  border: 1px solid #d4d4d8;',
  '  background: #ffffff;',
  '  color: #18181b;',
  '  border-radius: 4px;',
  '  cursor: pointer;',
  '  font-size: 12px;',
  '  font-family: inherit;',
  '  white-space: nowrap;',
  '  line-height: 1.4;',
  '}',
  '.rv-modes button:hover, .rv-fs:hover { background: #f4f4f5; }',
  '.rv-modes button[aria-pressed="true"] {',
  '  background: #18181b;',
  '  color: #ffffff;',
  '  border-color: #18181b;',
  '}',
  '',
  '/* Stage — only scrollable region. Toolbar/footer stay pinned. */',
  '.rv-stage {',
  '  flex: 1 1 auto;',
  '  min-height: 0;',
  '  overflow: auto;',
  '  padding: 16px;',
  '}',
  '',
  '/* Slide nav footer */',
  '.rv-slidenav {',
  '  flex: 0 0 auto;',
  '  z-index: 100;',
  '  background: #ffffff;',
  '  border-top: 1px solid #e5e7eb;',
  '  padding: 8px;',
  '  display: flex;',
  '  align-items: center;',
  '  justify-content: center;',
  '  gap: 16px;',
  '  font-family: system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;',
  '}',
  '.rv-slidenav[hidden] { display: none; }',
  '.rv-slidenav button {',
  '  padding: 4px 14px;',
  '  border: 1px solid #d4d4d8;',
  '  background: #ffffff;',
  '  border-radius: 4px;',
  '  cursor: pointer;',
  '  font-size: 14px;',
  '  font-family: inherit;',
  '}',
  '.rv-slidenav button:hover { background: #f4f4f5; }',
  '.rv-slidenav button:disabled { opacity: 0.4; cursor: not-allowed; }',
  '.rv-pageinfo {',
  '  font-size: 13px;',
  '  color: #52525b;',
  '  min-width: 60px;',
  '  text-align: center;',
  '}',
  '',
  '/* Single-page reports — hide slide button + slide nav */',
  '.rv-shell[data-pages="1"] .rv-modes button[data-mode="slide"] {',
  '  display: none;',
  '}',
  '',
  '/* ───── Layout preservation strategy ─────',
  '   Goal: the saved HTML should display widgets in the same arrangement',
  '   the author sees in the editor. RGL grid items are position:absolute',
  '   and do not contribute to the grid container`s intrinsic width, and',
  '   RGL does not always write the container width to inline style — so',
  '   bakeGridWidths() measures each grid live and pins width+maxWidth on',
  '   the clone (then `margin:0 auto` centers it within the full-width',
  '   page card). The page section itself stays width:auto. */',
  '',
  '/* page section uses content-box so any min-width applies to the',
  '   *content area*, not the border-box. With Tailwind`s default',
  '   border-box, padding',
  '   would eat into the min-width budget and the grid`s right edge',
  '   would still overflow the card padding. Content-box adds padding',
  '   outside the min-width, so the card always fully contains the */',
  '/*   grid no matter what mode / padding combination is active. */',
  '.rv-shell .report-detail-page {',
  '  box-sizing: content-box !important;',
  '}',
  '',
  '/* Center the RGL grid within its (full-width) page card. The grid has',
  '   a fixed inline px width and position:absolute cells, so left by',
  '   default; auto side-margins center it → the visible content sits in',
  '   the middle of the page instead of hugging the left with empty space',
  '   on the right. This is the actual content-centering lever. */',
  '.rv-shell .report-detail-page .react-grid-layout {',
  '  margin-left: auto !important;',
  '  margin-right: auto !important;',
  '}',
  '',
  '/* ───── Mode: all (default) — pages stacked, each as a card ───── */',
  '/* The page card fills the stage width (block, width:auto) with a',
  '   min-width floor = its RGL grid px. The grid inside (fixed width,',
  '   position:absolute cells) is centered within the card by the',
  '   `.react-grid-layout { margin: 0 auto }` rule below — that is what',
  '   actually centers the visible content. scale-to-fit then shrinks the',
  '   card when the window is narrower than the grid. */',
  '.rv-shell[data-view="all"] .report-detail-page {',
  '  margin: 0 0 24px 0;',
  '  padding: 24px 28px;',
  '  background: #ffffff;',
  '  border: 1px solid #e5e7eb;',
  '  border-radius: 8px;',
  '  box-shadow: 0 1px 3px rgba(0,0,0,0.03);',
  '}',
  '',
  '/* ───── Mode: slide — one page visible ───── */',
  '.rv-shell[data-view="slide"] .report-detail-page { display: none !important; }',
  '.rv-shell[data-view="slide"] .report-detail-page.rv-active {',
  '  display: block !important;',
  '  margin: 0;',
  '  padding: 32px 36px;',
  '  background: #ffffff;',
  '  border: 1px solid #e5e7eb;',
  '  border-radius: 8px;',
  '  box-shadow: 0 2px 12px rgba(0,0,0,0.06);',
  '}',
  '',
  '/* ───── Browse panel — opened by the 펼치기 toggle in page-strip ─────',
  '   Built by buildStaticBrowsePanel(); rendered at export time with',
  '   html2canvas thumbnails baked in. The toggle button (kept from the',
  '   editor DOM) flips `hidden`. */',
  '.rv-browse-panel {',
  '  border-top: 1px solid #e5e7eb;',
  '  background: #ffffff;',
  '  padding: 10px 24px 14px;',
  '}',
  '.rv-browse-panel[hidden] { display: none; }',
  '.rv-browse-header {',
  '  display: flex;',
  '  align-items: center;',
  '  gap: 12px;',
  '  margin-bottom: 12px;',
  '}',
  '.rv-browse-search {',
  '  flex: 1;',
  '  max-width: 360px;',
  '  padding: 4px 8px;',
  '  font-size: 12px;',
  '  border: 1px solid #d4d4d8;',
  '  border-radius: 4px;',
  '  font-family: inherit;',
  '  outline: none;',
  '}',
  '.rv-browse-search:focus { border-color: #18181b; }',
  '.rv-browse-count {',
  '  font-size: 12px;',
  '  color: #71717a;',
  '  font-variant-numeric: tabular-nums;',
  '}',
  '.rv-browse-close {',
  '  padding: 4px 10px;',
  '  font-size: 12px;',
  '  color: #52525b;',
  '  background: #ffffff;',
  '  border: 1px solid #d4d4d8;',
  '  border-radius: 4px;',
  '  cursor: pointer;',
  '  font-family: inherit;',
  '  margin-left: auto;',
  '}',
  '.rv-browse-close:hover { background: #f4f4f5; }',
  '.rv-browse-grid {',
  '  display: grid;',
  '  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));',
  '  gap: 12px;',
  '  max-height: 30vh;',
  '  overflow-y: auto;',
  '  padding-bottom: 4px;',
  '}',
  '.rv-browse-card {',
  '  display: flex;',
  '  flex-direction: column;',
  '  padding: 6px;',
  '  background: #ffffff;',
  '  border: 1px solid #d4d4d8;',
  '  border-radius: 4px;',
  '  cursor: pointer;',
  '  text-align: left;',
  '  font-family: inherit;',
  '  transition: background .12s, border-color .12s, box-shadow .12s;',
  '}',
  '.rv-browse-card:hover {',
  '  background: #f4f4f5;',
  '  border-color: #18181b;',
  '  box-shadow: 0 2px 8px rgba(0,0,0,0.05);',
  '}',
  '.rv-browse-card.rv-chip-active {',
  '  border-color: #18181b;',
  '  background: #fafafa;',
  '  box-shadow: 0 0 0 1px #18181b inset;',
  '}',
  '.rv-browse-card-label {',
  '  display: flex;',
  '  align-items: center;',
  '  gap: 6px;',
  '  margin-bottom: 6px;',
  '}',
  '.rv-browse-card-num {',
  '  font-size: 10px;',
  '  color: #71717a;',
  '  font-variant-numeric: tabular-nums;',
  '  flex-shrink: 0;',
  '}',
  '.rv-browse-card-name {',
  '  font-size: 12px;',
  '  color: #18181b;',
  '  overflow: hidden;',
  '  text-overflow: ellipsis;',
  '  white-space: nowrap;',
  '  min-width: 0;',
  '}',
  '.rv-browse-card-thumb {',
  '  width: 100%;',
  '  height: auto;',
  '  display: block;',
  '  border: 1px solid #e5e7eb;',
  '  border-radius: 2px;',
  '}',
  '.rv-browse-card-thumb-empty {',
  '  display: flex;',
  '  align-items: center;',
  '  justify-content: center;',
  '  font-size: 10px;',
  '  color: #a1a1aa;',
  '  padding: 30px 0;',
  '  border: 1px dashed #e5e7eb;',
  '  border-radius: 2px;',
  '}',
  '',
  '/* Print: ignore viewer chrome so Ctrl+P falls back to the all-pages',
  '   layout (sticky toolbar/footer would otherwise sit on every page). */',
  '@media print {',
  '  .rv-toolbar, .rv-slidenav, .report-detail-pagestrip, .rv-browse-panel { display: none !important; }',
  '  .rv-stage { padding: 0; }',
  '  .rv-shell[data-view] .report-detail-page {',
  '    display: block !important;',
  '    margin: 0 0 16px !important;',
  '    padding: 0 !important;',
  '    border: none !important;',
  '    box-shadow: none !important;',
  '    page-break-after: always;',
  '  }',
  '}',
].join('\n')

// Vanilla JS that drives the viewer chrome. Embedded as a string into
// the exported file via a single inline <script>. No closures over
// module state — everything reads from the DOM and the `.rv-shell`'s
// attributes so the script is self-contained and survives any future
// build-tool change.
const VIEWER_SCRIPT = [
  '(function () {',
  '  var shell = document.querySelector(".rv-shell");',
  '  if (!shell) return;',
  '  var pages = Array.prototype.slice.call(shell.querySelectorAll(".report-detail-page"));',
  '  if (pages.length === 0) return;',
  '  var currentIdx = 0;',
  '  var modeButtons = shell.querySelectorAll(".rv-modes button");',
  '  var slideNav = shell.querySelector(".rv-slidenav");',
  '  var pageNowEl = shell.querySelector(".rv-pagenow");',
  '  var prevBtn = shell.querySelector(".rv-prev");',
  '  var nextBtn = shell.querySelector(".rv-next");',
  '  var fsBtn = shell.querySelector(".rv-fs");',
  '',
  '  function setMode(mode) {',
  '    if (mode !== "all" && mode !== "slide") return;',
  '    if (pages.length === 1 && mode !== "all") mode = "all";',
  '    shell.setAttribute("data-view", mode);',
  '    for (var i = 0; i < modeButtons.length; i++) {',
  '      var b = modeButtons[i];',
  '      b.setAttribute("aria-pressed", b.getAttribute("data-mode") === mode ? "true" : "false");',
  '    }',
  '    if (slideNav) slideNav.hidden = mode !== "slide";',
  '    if (mode === "slide") updateActive();',
  '    fitPages();',
  '  }',
  '',
  '  function updateActive() {',
  '    for (var i = 0; i < pages.length; i++) {',
  '      var on = i === currentIdx;',
  '      if (on) pages[i].classList.add("rv-active");',
  '      else pages[i].classList.remove("rv-active");',
  '    }',
  '    if (pageNowEl) pageNowEl.textContent = String(currentIdx + 1);',
  '    if (prevBtn) prevBtn.disabled = currentIdx === 0;',
  '    if (nextBtn) nextBtn.disabled = currentIdx === pages.length - 1;',
  '    // Scroll the stage (not the window — toolbar/footer are pinned',
  '    // and would shift the page down by toolbar height otherwise) so',
  '    // the active page starts at the visible top. In slide mode only',
  '    // one page is rendered, so 0 is always the right offset.',
  '    var stage = shell.querySelector(".rv-stage");',
  '    if (stage) stage.scrollTop = 0;',
  '    fitPages();',
  '  }',
  '',
  '  // scale-to-fit — the grid carries the (fixed) content width. When it',
  '  // is wider than the visible stage, shrink it with CSS zoom so it fits',
  '  // and stays centered (zoom reflows layout, unlike transform, so the',
  '  // grid`s `margin:0 auto` keeps centering it). Grids narrower than the',
  '  // stage stay at 1:1 and just center with side margins. Recomputed on',
  '  // load, resize, and mode/page changes.',
  '  function fitPages() {',
  '    var stage = shell.querySelector(".rv-stage");',
  '    if (!stage) return;',
  '    var avail = stage.clientWidth - 72;', // rv-stage 16px*2 + page card ~28px*2 padding
  '    if (avail <= 0) return;',
  '    var grids = shell.querySelectorAll(".report-detail-page .react-grid-layout");',
  '    for (var fi = 0; fi < grids.length; fi++) {',
  '      var g = grids[fi];',
  '      g.style.zoom = "";',
  '      var natural = g.offsetWidth;',
  '      if (natural > 0 && natural > avail) g.style.zoom = String(avail / natural);',
  '    }',
  '  }',
  '',
  '  function goTo(idx) {',
  '    if (idx < 0) idx = 0;',
  '    if (idx > pages.length - 1) idx = pages.length - 1;',
  '    currentIdx = idx;',
  '    updateActive();',
  '    updateChipActive();',
  '  }',
  '',
  '  // Toggle `.rv-chip-active` on whichever chip / browse-card matches',
  '  // currentIdx. Called by goTo() and the chip-click handler so the',
  '  // strip and browse panel both reflect the currently viewed page.',
  '  // The CSS reset above ensures all chips start neutral regardless',
  '  // of which one React marked as active at export time.',
  '  function updateChipActive() {',
  '    var chips = shell.querySelectorAll("[data-page-chip-idx]");',
  '    for (var i = 0; i < chips.length; i++) {',
  '      var ci = parseInt(chips[i].getAttribute("data-page-chip-idx"), 10);',
  '      if (ci === currentIdx) chips[i].classList.add("rv-chip-active");',
  '      else chips[i].classList.remove("rv-chip-active");',
  '    }',
  '  }',
  '',
  '  for (var i = 0; i < modeButtons.length; i++) {',
  '    (function (b) {',
  '      b.addEventListener("click", function () { setMode(b.getAttribute("data-mode")); });',
  '    })(modeButtons[i]);',
  '  }',
  '  if (prevBtn) prevBtn.addEventListener("click", function () { goTo(currentIdx - 1); });',
  '  if (nextBtn) nextBtn.addEventListener("click", function () { goTo(currentIdx + 1); });',
  '',
  '  // Browse panel — built statically by buildStaticBrowsePanel() with',
  '  // html2canvas thumbnails baked in. The "펼치기/접기" toggle button',
  '  // was kept from the editor DOM (data-page-strip-toggle); React`s',
  '  // onClick did not survive cloneNode, so we are the only handler.',
  '  var browsePanel = shell.querySelector("[data-page-strip-panel]");',
  '  var browseToggle = shell.querySelector("[data-page-strip-toggle]");',
  '  var browseToggleLabel = browseToggle ? browseToggle.querySelector("[data-page-strip-toggle-label]") : null;',
  '  function setBrowseOpen(open) {',
  '    if (!browsePanel) return;',
  '    browsePanel.hidden = !open;',
  '    if (browseToggle) browseToggle.setAttribute("aria-expanded", open ? "true" : "false");',
  '    if (browseToggleLabel) browseToggleLabel.textContent = open ? "접기" : "펼치기";',
  '  }',
  '  if (browseToggle && browsePanel) {',
  '    browseToggle.addEventListener("click", function (ev) {',
  '      ev.preventDefault();',
  '      ev.stopPropagation();',
  '      setBrowseOpen(browsePanel.hidden);',
  '    });',
  '    var browseClose = browsePanel.querySelector("[data-page-browse-close]");',
  '    if (browseClose) browseClose.addEventListener("click", function () { setBrowseOpen(false); });',
  '    // Live filter — match against page name + number, case-insensitive.',
  '    var browseQuery = browsePanel.querySelector("[data-page-browse-query]");',
  '    var browseCount = browsePanel.querySelector("[data-page-browse-count]");',
  '    var browseCards = browsePanel.querySelectorAll(".rv-browse-card");',
  '    if (browseQuery) {',
  '      browseQuery.addEventListener("input", function () {',
  '        var q = (browseQuery.value || "").trim().toLowerCase();',
  '        var shown = 0;',
  '        for (var b = 0; b < browseCards.length; b++) {',
  '          var card = browseCards[b];',
  '          var name = (card.getAttribute("data-search") || "").toLowerCase();',
  '          var match = !q || name.indexOf(q) >= 0;',
  '          card.style.display = match ? "" : "none";',
  '          if (match) shown++;',
  '        }',
  '        if (browseCount) browseCount.textContent = shown + " / " + browseCards.length;',
  '      });',
  '    }',
  '    // Force-collapse the panel on load — the editor may have been',
  '    // mid-expanded when the export ran, but we want the saved file to',
  '    // open with the panel closed so the report itself is the first',
  '    // thing the reader sees.',
  '    setBrowseOpen(false);',
  '  }',
  '',
  '  // Page-strip chips kept from the editor DOM — give them functional',
  '  // click handlers so the inline tab row is actual navigation, not',
  '  // decoration. Browse-panel cards share the same `data-page-chip-idx`',
  '  // attribute so they pick up the same handler for free. Behavior by',
  '  // mode:',
  '  //   all   — scroll the matching page into view (stage is the',
  '  //           scroll container; scrollIntoView walks up to it).',
  '  //   slide — jump to that page via goTo().',
  '  // React-supplied onClick listeners did not survive cloneNode(),',
  '  // so the chip is otherwise inert — we are the only handler.',
  '  var pageChips = shell.querySelectorAll("[data-page-chip-idx]");',
  '  for (var k = 0; k < pageChips.length; k++) {',
  '    (function (chip) {',
  '      chip.addEventListener("click", function (ev) {',
  '        var idx = parseInt(chip.getAttribute("data-page-chip-idx"), 10);',
  '        if (isNaN(idx) || idx < 0 || idx >= pages.length) return;',
  '        ev.preventDefault();',
  '        ev.stopPropagation();',
  '        var mode = shell.getAttribute("data-view");',
  '        if (mode === "all") {',
  '          currentIdx = idx;',
  '          updateChipActive();',
  '          var target = pages[idx];',
  '          if (target && target.scrollIntoView) {',
  '            target.scrollIntoView({ behavior: "smooth", block: "start" });',
  '          }',
  '        } else {',
  '          goTo(idx);',
  '        }',
  '        // Navigating from a browse-panel card auto-collapses the panel',
  '        // so the reader sees the destination page without an extra',
  '        // dismiss click. Strip chip clicks leave it as-is (panel was',
  '        // never opened by them anyway).',
  '        if (chip.closest && chip.closest("[data-page-strip-panel]")) {',
  '          setBrowseOpen(false);',
  '        }',
  '      });',
  '    })(pageChips[k]);',
  '  }',
  '',
  '  // Fullscreen — vendor-prefixed fallbacks for older Safari, but the',
  '  // standard `requestFullscreen` works in all modern browsers.',
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
  '',
  '  // Keyboard shortcuts.',
  '  //   Ctrl/Cmd+1/2 — mode switch',
  '  //   ←/PgUp · →/PgDn/Space — prev/next (slide mode only)',
  '  //   Home/End — first/last (slide mode only)',
  '  //   F — fullscreen toggle',
  '  document.addEventListener("keydown", function (e) {',
  '    var t = e.target;',
  '    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;',
  '    if (e.ctrlKey || e.metaKey) {',
  '      if (e.key === "1") { e.preventDefault(); setMode("all"); return; }',
  '      if (e.key === "2") { e.preventDefault(); setMode("slide"); return; }',
  '      return;',
  '    }',
  '    var mode = shell.getAttribute("data-view");',
  '    if (mode === "slide") {',
  '      if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); goTo(currentIdx - 1); return; }',
  '      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); goTo(currentIdx + 1); return; }',
  '      if (e.key === "Home") { e.preventDefault(); goTo(0); return; }',
  '      if (e.key === "End") { e.preventDefault(); goTo(pages.length - 1); return; }',
  '    }',
  '    if (e.key === "f" || e.key === "F") {',
  '      e.preventDefault();',
  '      toggleFs();',
  '    }',
  '  });',
  '',
  '  window.addEventListener("resize", fitPages);',
  '  setMode("all");',
  '  fitPages();',
  '  // Seed the chip / browse-card highlight to currentIdx (= 0). The',
  '  // CSS reset above neutralizes any inherited React active styling,',
  '  // and this paints the first chip as the initial "current page".',
  '  updateChipActive();',
  '})();',
].join('\n')

// --- Helpers --------------------------------------------------------- //

// Prevent the JSON spec block from accidentally closing its host
// `<script type="application/json">` if any user-supplied string
// contains `</script>` (e.g., a chart annotation label embedding raw
// HTML). The replacement keeps JSON syntactically valid — `\/` and
// `<` are interchangeable in JSON string literals.
export function escapeScriptJson(json) {
  return String(json ?? '').replace(/<\/(script)/gi, '<\\/$1')
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function escapeAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;')
}

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
  // Defer revoke — 즉시 revoke 시 Chromium 다운로드 fetch 가 끝나기 전에
  // URL 이 사라져 콘솔에 ERR_FILE_NOT_FOUND. (자세한 사유는 exportReportToDocx
  // 의 같은 함수 주석 참고.)
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
