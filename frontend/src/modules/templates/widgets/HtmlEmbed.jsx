import { useEffect, useRef, useState } from 'react'
import { FileCode2, Folder, FolderUp, Loader2, Upload, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { fetchFileBlob, uploadFile } from '@/shared/api/files'
import {
  createEmbedBundle,
  deleteEmbedBundle,
  embedBundleUrl,
} from '@/shared/api/embed'
import { toast } from 'sonner'
import {
  CaptionInput,
  LabelField,
  PreviewLabel,
  captionSkipProps,
} from './_shared'

/**
 * HTML embed widget — author uploads either a single `.html` file or a
 * whole folder (main HTML + sub json/js/css/images, 구조 그대로) and the
 * widget renders it in an isolated `sandbox="allow-scripts"` iframe (null
 * origin — author scripts run but can't reach the report's cookies / DOM /
 * storage).
 *
 *   - single file  → bytes fetched + inlined via `srcdoc` (legacy path).
 *   - folder bundle → files served at /api/embed/{bundle_id}/<relpath> so
 *     the main HTML's relative src/href/fetch resolve naturally; iframe
 *     loads it via `src` (HTML임베드_번들_설계.md).
 *
 * AI never fills this — it needs a real upload (file_id / bundle_id).
 */

export function HtmlEmbedPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="HTML"
      />
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        업로드한 HTML 은 sandbox iframe 안에서 렌더됩니다 — 스크립트는 실행되지만
        보고서 본문의 쿠키 / 로컬 스토리지엔 접근할 수 없습니다. 폴더를 올리면
        메인 HTML + 서브 파일(json·js·이미지)을 구조 그대로 임베드합니다.
      </p>
    </div>
  )
}

export function HtmlEmbedPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel>{props.label}</PreviewLabel>
      <div className="rounded-md border border-dashed bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
        <FileCode2 className="mx-auto mb-1 h-4 w-4" />
        HTML 파일/폴더를 업로드하면 여기에 표시됩니다.
      </div>
    </div>
  )
}

// ── 폴더 수집 헬퍼 ──────────────────────────────────────────────────────────

const _JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|__MACOSX\/)/i

function isHtml(path) {
  const p = path.toLowerCase()
  return p.endsWith('.html') || p.endsWith('.htm')
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// 모든 항목이 같은 최상위 폴더 한 겹을 공유하면 그걸 벗긴다
// (webkitdirectory 는 항상 "폴더명/..." 로 시작 → entry 가 index.html 이 되게).
function stripCommonRoot(entries) {
  if (entries.length === 0) return entries
  const first = entries[0].path.split('/')[0]
  if (!first) return entries
  const allShare = entries.every(
    (e) => e.path.startsWith(`${first}/`) && e.path.length > first.length + 1,
  )
  if (!allShare) return entries
  return entries.map((e) => ({ file: e.file, path: e.path.slice(first.length + 1) }))
}

// 메인(엔트리) HTML 기본 추정 — index.html 우선, 없으면 첫 html, 없으면 첫 파일.
function pickEntryDefault(paths) {
  const idx = paths.find((p) => p === 'index.html' || p.endsWith('/index.html'))
  if (idx) return idx
  const html = paths.find(isHtml)
  return html || paths[0] || ''
}

// 드래그앤드롭에서 폴더 구조를 재귀로 읽어 [{file, path}] 로. webkitGetAsEntry
// 는 drop 이벤트 동안 동기로 잡아야 하므로(아이템 리스트가 곧 비워짐) 먼저
// 엔트리를 캡처한 뒤 비동기로 순회한다.
async function readEntry(entry, prefix, out) {
  if (entry.isFile) {
    await new Promise((resolve, reject) =>
      entry.file((f) => {
        out.push({ file: f, path: prefix + entry.name })
        resolve()
      }, reject),
    )
  } else if (entry.isDirectory) {
    const reader = entry.createReader()
    const readBatch = () =>
      new Promise((resolve, reject) => reader.readEntries(resolve, reject))
    let batch
    do {
      batch = await readBatch()
      for (const e of batch) await readEntry(e, `${prefix}${entry.name}/`, out)
    } while (batch.length > 0)
  }
}

async function entriesFromDataTransfer(dt) {
  const roots = Array.from(dt.items || [])
    .map((it) => it.webkitGetAsEntry?.())
    .filter(Boolean)
  if (roots.length) {
    const out = []
    for (const r of roots) await readEntry(r, '', out)
    return out
  }
  // 폴백: 플랫 파일 목록.
  return Array.from(dt.files || []).map((f) => ({
    file: f,
    path: f.webkitRelativePath || f.name,
  }))
}

// ── 에디터 ──────────────────────────────────────────────────────────────────

export function HtmlEmbedEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  const fileId = content?.file_id ?? null
  const bundleId = content?.bundle_id ?? null
  const entryPath = content?.entry_path ?? ''
  const filename = content?.filename ?? ''
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  // 폴더를 고른 뒤 "엔트리 지정 + 업로드" 전 단계 staging.
  const [staged, setStaged] = useState(null) // {entries:[{file,path}], entryPath} | null
  const singleInputRef = useRef(null)
  const folderInputRef = useRef(null)

  function patch(next) {
    const merged = { ...(content ?? {}), ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (!merged.file_id) delete merged.file_id
    if (!merged.bundle_id) {
      delete merged.bundle_id
      delete merged.entry_path
    }
    if (!merged.file_id && !merged.bundle_id) delete merged.filename
    onChange(merged)
  }

  // 단일 .html 업로드 (레거시 srcdoc 경로).
  async function handleSingleFiles(fileList) {
    const incoming = Array.from(fileList || [])
    if (incoming.length === 0) return
    const file = incoming[0]
    const lower = file.name.toLowerCase()
    if (!lower.endsWith('.html') && !lower.endsWith('.htm')) {
      const proceed = window.confirm(
        `'${file.name}' 은 .html / .htm 확장자가 아닙니다. 그대로 업로드할까요?`,
      )
      if (!proceed) return
    }
    setUploading(true)
    try {
      const meta = await uploadFile(file)
      // 단일로 바꾸면 기존 번들은 정리.
      if (bundleId) deleteEmbedBundle(bundleId).catch(() => {})
      patch({ file_id: meta.id, filename: meta.filename, bundle_id: undefined })
    } catch (err) {
      toast.error(err.message || '업로드 실패')
    } finally {
      setUploading(false)
      if (singleInputRef.current) singleInputRef.current.value = ''
    }
  }

  // 폴더(또는 다중 파일) → staging 으로.
  function beginStaging(rawEntries) {
    const cleaned = stripCommonRoot(
      rawEntries.filter((e) => e.path && !_JUNK.test(e.path)),
    )
    if (cleaned.length === 0) {
      toast.error('업로드할 파일이 없습니다.')
      return
    }
    const paths = cleaned.map((e) => e.path)
    setStaged({ entries: cleaned, entryPath: pickEntryDefault(paths) })
  }

  function handleFolderInput(fileList) {
    const entries = Array.from(fileList || []).map((f) => ({
      file: f,
      path: f.webkitRelativePath || f.name,
    }))
    if (entries.length === 0) return
    beginStaging(entries)
    if (folderInputRef.current) folderInputRef.current.value = ''
  }

  async function onDrop(e) {
    e.preventDefault()
    if (readOnly) return
    const entries = await entriesFromDataTransfer(e.dataTransfer)
    if (entries.length === 0) return
    // 단일 html 한 개만 떨군 경우는 레거시 단일 경로로(서버 번들 안 만듦).
    if (
      entries.length === 1 &&
      isHtml(entries[0].path) &&
      !entries[0].path.includes('/')
    ) {
      await handleSingleFiles([entries[0].file])
      return
    }
    beginStaging(entries)
  }

  async function uploadStaged() {
    if (!staged) return
    if (!staged.entryPath) {
      toast.error('메인 HTML 파일을 선택하세요.')
      return
    }
    setUploading(true)
    setProgress(0)
    try {
      const meta = await createEmbedBundle(staged.entries, staged.entryPath, {
        onProgress: setProgress,
      })
      const base = meta.entry_path.split('/').pop()
      patch({
        bundle_id: meta.id,
        entry_path: meta.entry_path,
        filename: base,
        file_id: undefined,
      })
      setStaged(null)
    } catch (err) {
      toast.error(err.message || '번들 업로드 실패')
    } finally {
      setUploading(false)
      setProgress(0)
    }
  }

  function clearMedia() {
    if (!window.confirm('업로드된 HTML 을 제거할까요?')) return
    if (bundleId) deleteEmbedBundle(bundleId).catch(() => {})
    patch({
      file_id: undefined,
      bundle_id: undefined,
      entry_path: undefined,
      filename: undefined,
    })
  }

  const hasMedia = Boolean(fileId || bundleId)
  const stagedTotal = staged
    ? staged.entries.reduce((s, e) => s + (e.file.size || 0), 0)
    : 0

  return (
    <div className="space-y-2 flex flex-col h-full min-h-0">
      <CaptionInput
        value={caption}
        readOnly={readOnly}
        onChange={readOnly ? undefined : (v) => patch({ caption: v })}
        placeholder={props.label}
        {...(readOnly
          ? { skipAutofill: content?.caption_skip_autofill }
          : captionSkipProps({ content, patch }))}
      />

      {hasMedia ? (
        <>
          {!readOnly && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {bundleId ? (
                <Folder className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <FileCode2 className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate flex-1">
                {bundleId
                  ? `${entryPath || filename} · 폴더 번들`
                  : filename || fileId}
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
          )}
          <HtmlEmbedFrame
            fileId={fileId}
            bundleId={bundleId}
            entryPath={entryPath}
            title={filename || props.label}
          />
        </>
      ) : (
        !readOnly &&
        (staged ? (
          // ── staging: 파일 목록 + 엔트리 지정 + 업로드 ──
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {staged.entries.length}개 파일 · {fmtBytes(stagedTotal)}
              </span>
              {!uploading && (
                <button
                  type="button"
                  onClick={() => setStaged(null)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  취소
                </button>
              )}
            </div>
            <label className="block text-xs">
              <span className="text-muted-foreground">메인 HTML</span>
              <select
                value={staged.entryPath}
                disabled={uploading}
                onChange={(e) =>
                  setStaged((s) => ({ ...s, entryPath: e.target.value }))
                }
                className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-[11px]"
              >
                {[...staged.entries]
                  .map((e) => e.path)
                  .sort((a, b) => Number(isHtml(b)) - Number(isHtml(a)))
                  .map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
              </select>
            </label>
            <div className="max-h-28 overflow-y-auto rounded border bg-muted/20 p-1.5 text-[10px] text-muted-foreground">
              {staged.entries.map((e) => (
                <div key={e.path} className="truncate">
                  {e.path === staged.entryPath ? '▶ ' : ''}
                  {e.path}
                </div>
              ))}
            </div>
            <Button
              size="sm"
              className="w-full"
              disabled={uploading}
              onClick={uploadStaged}
            >
              {uploading ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  업로드 중… {Math.round(progress * 100)}%
                </>
              ) : (
                '번들 업로드'
              )}
            </Button>
          </div>
        ) : (
          // ── 빈 상태: 드롭존 + 단일/폴더 버튼 ──
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            className="border-2 border-dashed rounded-md p-6 text-center transition-colors hover:bg-muted/30"
          >
            {uploading ? (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-xs">업로드 중…</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 text-muted-foreground">
                <Upload className="h-5 w-5" />
                <span className="text-xs">
                  HTML 파일·폴더를 드래그하거나 아래에서 선택
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => singleInputRef.current?.click()}
                  >
                    <FileCode2 className="mr-1 h-3.5 w-3.5" />
                    HTML 파일
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => folderInputRef.current?.click()}
                  >
                    <FolderUp className="mr-1 h-3.5 w-3.5" />
                    폴더
                  </Button>
                </div>
              </div>
            )}
            <input
              ref={singleInputRef}
              type="file"
              accept=".html,.htm,text/html"
              className="hidden"
              onChange={(e) => handleSingleFiles(e.target.files)}
            />
            {/* webkitdirectory 는 표준 prop 이 아니라 ref 로 직접 켠다. */}
            <input
              ref={(el) => {
                folderInputRef.current = el
                if (el) {
                  el.webkitdirectory = true
                  el.directory = true
                }
              }}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleFolderInput(e.target.files)}
            />
          </div>
        ))
      )}
    </div>
  )
}

/**
 * Renders the embed. Bundle mode loads /api/embed/{bundle_id}/{entry_path}
 * via `src` (relative URL → host-agnostic); single-file mode fetches the
 * bytes and inlines via `srcdoc`. Both use `sandbox="allow-scripts"`
 * (null origin) so author scripts run but stay isolated from the report.
 */
function HtmlEmbedFrame({ fileId, bundleId, entryPath, title }) {
  const [html, setHtml] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    // 번들 모드는 src 로 직접 로드 — 바이트를 안 가져온다.
    if (bundleId || !fileId) {
      setHtml('')
      return undefined
    }
    let cancelled = false
    setLoading(true)
    setError('')
    ;(async () => {
      try {
        const blob = await fetchFileBlob(fileId)
        const text = await blob.text()
        if (!cancelled) setHtml(text)
      } catch (e) {
        if (!cancelled) setError(e?.message || '불러오기 실패')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fileId, bundleId])

  const frameClass =
    'flex-1 w-full min-h-[12rem] rounded-md border bg-background'

  if (bundleId) {
    return (
      <iframe
        title={title || 'HTML embed'}
        src={embedBundleUrl(bundleId, entryPath || 'index.html')}
        sandbox="allow-scripts"
        className={frameClass}
      />
    )
  }
  if (loading) {
    return (
      <div className="flex-1 min-h-[12rem] flex items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        HTML 불러오는 중…
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex-1 min-h-[12rem] flex items-center justify-center text-xs text-destructive">
        {error}
      </div>
    )
  }
  return (
    <iframe
      title={title || 'HTML embed'}
      srcDoc={html}
      sandbox="allow-scripts"
      className={frameClass}
    />
  )
}
