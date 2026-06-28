import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  Maximize2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { fetchFileBlob, uploadFile } from '@/shared/api/files'
import { toast } from 'sonner'
import {
  CaptionInput,
  LabelField,
  PreviewLabel,
  captionSkipProps,
  captionPositionOf,
} from './_shared'

/**
 * 문서 뷰어(doc_viewer) — author uploads a single PDF and the widget renders it
 * inline with PDF.js (page nav / zoom / fullscreen) instead of a download card.
 * This is the "보존(archive-as-is)" path for 논문·외부 규격서 PDF: the canonical
 * document stays intact, and its text layer is extracted client-side at upload
 * time into `content.extracted_text` so it flows into search_text / report_chunks
 * via the standard backend text-extraction path — no server-side PDF dependency
 * (문서가져오기_설계.md §4). Scanned PDFs (image-only, no text layer) leave the
 * text empty; OCR is future work (§10).
 *
 * AI never fills this — like image / attachment / cad_3d, it needs a real upload.
 *
 * Heavy `pdfjs-dist` is pulled in via dynamic import (same pattern as Cad3d/three)
 * so it is code-split out of the main bundle.
 */

// ── PDF.js loader (lazy, once) ───────────────────────────────────────────────
let _pdfjsPromise = null
function loadPdfjs() {
  if (!_pdfjsPromise) {
    _pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist')
      // Vite turns `?url` into the emitted asset path for the module worker.
      const workerUrl = (
        await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
      ).default
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
      return pdfjs
    })()
  }
  return _pdfjsPromise
}

// Cap on extracted text so a huge PDF doesn't bloat the report content JSON.
// Mirrors the spirit of text_extraction.py's 100k total cap on the backend.
const MAX_EXTRACT_CHARS = 400000

async function extractPdfText(doc) {
  const parts = []
  let total = 0
  for (let i = 1; i <= doc.numPages; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const page = await doc.getPage(i)
    // eslint-disable-next-line no-await-in-loop
    const tc = await page.getTextContent()
    const str = tc.items.map((it) => it.str || '').join(' ').trim()
    if (str) {
      parts.push(str)
      total += str.length
    }
    page.cleanup?.()
    if (total >= MAX_EXTRACT_CHARS) break
  }
  return parts.join('\n\n').slice(0, MAX_EXTRACT_CHARS)
}

function fmtBytes(n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// ── PropsPanel ───────────────────────────────────────────────────────────────

export function DocViewerPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="문서"
      />
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        업로드한 PDF 를 본문 안에서 바로 열람합니다 — 페이지 넘김·확대·전체화면을
        지원하고, 텍스트는 자동 추출되어 검색/AI 에 반영됩니다. 스캔본(이미지) PDF 는
        텍스트가 없어 검색에 잡히지 않을 수 있습니다.
      </p>
    </div>
  )
}

export function DocViewerPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel>{props.label}</PreviewLabel>
      <div className="rounded-md border border-dashed bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
        <FileText className="mx-auto mb-1 h-4 w-4" />
        PDF 파일을 업로드하면 여기에 표시됩니다.
      </div>
    </div>
  )
}

// ── Editor ───────────────────────────────────────────────────────────────────

export function DocViewerEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  const fileId = content?.file_id ?? null
  const filename = content?.filename ?? ''
  const size = content?.size
  const capPos = captionPositionOf(content)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [indexing, setIndexing] = useState(false)
  const inputRef = useRef(null)

  function patch(next) {
    const merged = { ...(content ?? {}), ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (!merged.file_id) {
      delete merged.file_id
      delete merged.filename
      delete merged.size
      delete merged.mime_type
      delete merged.page_count
      delete merged.extracted_text
      delete merged.display
      delete merged.height_px
      delete merged.initial_page
    }
    // display="inline" 은 기본이므로 저장 안 함(키 제거 → 기본값을 탐).
    if (merged.display !== 'card') delete merged.display
    if (!merged.height_px) delete merged.height_px
    onChange(merged)
  }

  async function handleFiles(fileList) {
    const file = Array.from(fileList || [])[0]
    if (!file) return
    const lower = file.name.toLowerCase()
    if (!lower.endsWith('.pdf') && file.type !== 'application/pdf') {
      const ok = window.confirm(
        `'${file.name}' 은 PDF 가 아닙니다. 그대로 업로드할까요? (인라인 열람은 PDF 만 지원)`,
      )
      if (!ok) return
    }
    setUploading(true)
    setProgress(0)
    try {
      const meta = await uploadFile(file, { onProgress: setProgress })
      // 업로드 직후 클라이언트에서 페이지 수 + 텍스트 추출 → content 에 저장.
      // 실패해도 뷰어는 동작하므로 비치명적(스캔 PDF 면 텍스트가 빈 문자열).
      let page_count
      let extracted_text
      try {
        setIndexing(true)
        const pdfjs = await loadPdfjs()
        const data = await file.arrayBuffer()
        const doc = await pdfjs.getDocument({ data }).promise
        page_count = doc.numPages
        extracted_text = await extractPdfText(doc)
        doc.destroy?.()
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[DocViewer] 텍스트 추출 실패(뷰어는 정상):', e)
      } finally {
        setIndexing(false)
      }
      patch({
        file_id: meta.id,
        filename: meta.filename || file.name,
        size: meta.size ?? file.size,
        mime_type: meta.mime_type || file.type || 'application/pdf',
        page_count,
        extracted_text: extracted_text || undefined,
      })
    } catch (err) {
      toast.error(err.message || '업로드 실패')
    } finally {
      setUploading(false)
      setProgress(0)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function onDrop(e) {
    e.preventDefault()
    if (readOnly) return
    await handleFiles(e.dataTransfer?.files)
  }

  function clearMedia() {
    if (!window.confirm('업로드된 PDF 를 제거할까요?')) return
    patch({ file_id: undefined })
  }

  const captionNode = (
    <CaptionInput
      value={caption}
      readOnly={readOnly}
      onChange={readOnly ? undefined : (v) => patch({ caption: v })}
      placeholder={props.label}
      {...(readOnly
        ? { skipAutofill: content?.caption_skip_autofill }
        : captionSkipProps({ content, patch }))}
    />
  )

  return (
    <div className="space-y-2 flex flex-col h-full min-h-0">
      {capPos !== 'below' && captionNode}

      {fileId ? (
        <>
          {!readOnly && (
            <>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate flex-1">
                  {filename || fileId}
                  {size ? ` · ${fmtBytes(size)}` : ''}
                  {indexing ? ' · 텍스트 색인 중…' : ''}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-destructive"
                  onClick={clearMedia}
                  title="제거"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
              <DocViewerDisplayControls content={content} patch={patch} />
            </>
          )}
          <DocViewerView content={content} label={props.label} />
        </>
      ) : (
        !readOnly && (
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            className="border-2 border-dashed rounded-md p-6 text-center transition-colors hover:bg-muted/30"
          >
            {uploading ? (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-xs">
                  업로드 중… {Math.round(progress * 100)}%
                </span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 text-muted-foreground">
                <Upload className="h-5 w-5" />
                <span className="text-xs">
                  PDF 파일을 드래그하거나 아래에서 선택
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => inputRef.current?.click()}
                >
                  <FileText className="mr-1 h-3.5 w-3.5" />
                  PDF 파일
                </Button>
              </div>
            )}
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,application/pdf"
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </div>
        )
      )}

      {capPos === 'below' && captionNode}
    </div>
  )
}

// ── PDF render ───────────────────────────────────────────────────────────────

// Renders a single PDF page to a canvas at the given scale. Cancels the prior
// render task on page/scale change so pdf.js never throws "canvas in use".
function PdfPageCanvas({ doc, page, scale }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    if (!doc || !canvasRef.current) return undefined
    let cancelled = false
    let task = null
    ;(async () => {
      try {
        const pg = await doc.getPage(page)
        if (cancelled) return
        const dpr = window.devicePixelRatio || 1
        const viewport = pg.getViewport({ scale: scale * dpr })
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`
        task = pg.render({ canvasContext: ctx, viewport })
        await task.promise
      } catch (e) {
        if (e?.name !== 'RenderingCancelledException' && !cancelled) {
          // eslint-disable-next-line no-console
          console.warn('[DocViewer] 페이지 렌더 실패:', e)
        }
      }
    })()
    return () => {
      cancelled = true
      try {
        task?.cancel()
      } catch {
        /* noop */
      }
    }
  }, [doc, page, scale])
  return <canvas ref={canvasRef} className="mx-auto block shadow-sm" />
}

// Loads a PDF document by file_id and renders a paged viewer with a toolbar.
function PdfViewer({ fileId, initialPage = 1, className, style }) {
  const [doc, setDoc] = useState(null)
  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState(initialPage)
  const [scale, setScale] = useState(1.2)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!fileId) return undefined
    let cancelled = false
    let loaded = null
    setLoading(true)
    setError('')
    ;(async () => {
      try {
        const pdfjs = await loadPdfjs()
        const blob = await fetchFileBlob(fileId)
        const data = await blob.arrayBuffer()
        if (cancelled) return
        loaded = await pdfjs.getDocument({ data }).promise
        if (cancelled) {
          loaded.destroy?.()
          return
        }
        setDoc(loaded)
        setNumPages(loaded.numPages)
        setPage((p) => Math.min(Math.max(1, p), loaded.numPages))
      } catch (e) {
        if (!cancelled) setError(e?.message || 'PDF 불러오기 실패')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      if (loaded) loaded.destroy?.()
    }
  }, [fileId])

  if (loading) {
    return (
      <div
        className={`flex items-center justify-center rounded-md border bg-background text-xs text-muted-foreground ${className || ''}`}
        style={style}
      >
        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        PDF 불러오는 중…
      </div>
    )
  }
  if (error) {
    return (
      <div
        className={`flex items-center justify-center rounded-md border bg-background text-xs text-destructive ${className || ''}`}
        style={style}
      >
        {error}
      </div>
    )
  }

  const clampPage = (p) => Math.min(Math.max(1, p), numPages || 1)

  return (
    <div className={`flex flex-col rounded-md border bg-muted/30 ${className || ''}`} style={style}>
      <div className="flex items-center gap-1 border-b bg-background/80 px-2 py-1 text-xs">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          disabled={page <= 1}
          onClick={() => setPage((p) => clampPage(p - 1))}
          title="이전 페이지"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="tabular-nums text-muted-foreground">
          {page} / {numPages || '–'}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          disabled={page >= numPages}
          onClick={() => setPage((p) => clampPage(p + 1))}
          title="다음 페이지"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setScale((s) => Math.max(0.4, +(s - 0.2).toFixed(2)))}
            title="축소"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="w-10 text-center tabular-nums text-muted-foreground">
            {Math.round(scale * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setScale((s) => Math.min(4, +(s + 0.2).toFixed(2)))}
            title="확대"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {doc && <PdfPageCanvas doc={doc} page={page} scale={scale} />}
      </div>
    </div>
  )
}

// ── Fullscreen overlay (mirrors HtmlEmbed) ───────────────────────────────────

function FullscreenDoc({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])
  return createPortal(
    <div className="fixed inset-0 z-[200] flex flex-col bg-black/80 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-2 px-4 py-2 text-white/90">
        <span className="truncate text-sm font-medium">{title}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 hover:bg-white/10"
          title="닫기 (ESC)"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 px-4 pb-4">{children}</div>
    </div>,
    document.body,
  )
}

// ── View (display) ───────────────────────────────────────────────────────────

function DocViewerView({ content, label }) {
  const fileId = content?.file_id ?? null
  const filename = content?.filename ?? ''
  const pageCount = content?.page_count
  const display = content?.display === 'card' ? 'card' : 'inline'
  const height = content?.height_px ? `${content.height_px}px` : '70vh'
  const initialPage = content?.initial_page || 1
  const title = content?.caption || filename || label || '문서'
  const [fullscreen, setFullscreen] = useState(false)

  if (!fileId) return null

  // HTML export reads these markers to inline the PDF as a download link.
  const exportMarkers = {
    'data-export-doc': '',
    'data-export-doc-file-id': fileId,
    'data-export-doc-filename': filename || title || undefined,
  }

  async function downloadPdf() {
    try {
      const blob = await fetchFileBlob(fileId)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename || 'document.pdf'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      toast.error(err?.message || '다운로드 실패')
    }
  }

  const toolbar = (
    <div className="flex items-center gap-1">
      <Button variant="outline" size="sm" onClick={() => setFullscreen(true)}>
        <Maximize2 className="mr-1 h-3.5 w-3.5" />
        전체화면
      </Button>
      <Button variant="outline" size="sm" onClick={downloadPdf}>
        <Download className="mr-1 h-3.5 w-3.5" />
        다운로드
      </Button>
    </div>
  )

  const fullscreenNode = fullscreen ? (
    <FullscreenDoc title={title} onClose={() => setFullscreen(false)}>
      <PdfViewer
        fileId={fileId}
        initialPage={initialPage}
        className="h-full w-full border-0 bg-white"
      />
    </FullscreenDoc>
  ) : null

  if (display === 'inline') {
    return (
      <div className="space-y-2" {...exportMarkers}>
        <div className="flex items-center justify-end">{toolbar}</div>
        <PdfViewer fileId={fileId} initialPage={initialPage} style={{ height }} />
        {fullscreenNode}
      </div>
    )
  }

  // card 모드 — 표지(파일 정보) + 열기 버튼.
  return (
    <div className="rounded-md border bg-muted/20" {...exportMarkers}>
      <div className="flex items-stretch gap-3 p-3">
        <div className="flex h-16 w-24 shrink-0 items-center justify-center rounded border bg-background text-muted-foreground">
          <FileText className="h-6 w-6" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {filename}
            {pageCount ? ` · ${pageCount}쪽` : ''}
          </div>
          <div className="mt-auto pt-2">{toolbar}</div>
        </div>
      </div>
      {fullscreenNode}
    </div>
  )
}

// ── Display controls (edit mode) ─────────────────────────────────────────────

function DocViewerDisplayControls({ content, patch }) {
  const display = content?.display === 'card' ? 'card' : 'inline'
  return (
    <div className="space-y-2 rounded-md border bg-muted/10 p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">표시</span>
        <div className="flex overflow-hidden rounded-md border">
          <button
            type="button"
            onClick={() => patch({ display: 'card' })}
            className={`px-2 py-1 ${
              display === 'card'
                ? 'bg-primary text-primary-foreground'
                : 'bg-background hover:bg-muted'
            }`}
          >
            카드
          </button>
          <button
            type="button"
            onClick={() => patch({ display: 'inline' })}
            className={`px-2 py-1 ${
              display === 'inline'
                ? 'bg-primary text-primary-foreground'
                : 'bg-background hover:bg-muted'
            }`}
          >
            인라인
          </button>
        </div>
        {display === 'inline' && (
          <label className="ml-auto flex items-center gap-1">
            <span className="text-muted-foreground">높이(px)</span>
            <input
              type="number"
              min={120}
              max={4000}
              value={content?.height_px || ''}
              placeholder="자동"
              onChange={(e) => {
                const n = parseInt(e.target.value, 10)
                patch({ height_px: Number.isFinite(n) ? n : undefined })
              }}
              className="w-20 rounded border bg-background px-1.5 py-1 text-[11px]"
            />
          </label>
        )}
      </div>
    </div>
  )
}
