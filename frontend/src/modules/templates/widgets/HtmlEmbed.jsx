import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ExternalLink,
  FileCode2,
  Folder,
  FolderUp,
  ImagePlus,
  Loader2,
  Maximize2,
  Upload,
  X,
} from 'lucide-react'
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
  const migratedRef = useRef(false)
  const [migrating, setMigrating] = useState(false)

  // 레거시 자동 마이그레이션 — 기존 단일 파일(file_id srcdoc) 블록을 편집 모드로
  // 열면 1-파일 번들로 옮긴다(§8.1). 그래야 옛 블록도 새 탭/CSP sandbox 격리를
  // 얻는다. 이미 가져오는 srcdoc 바이트를 그대로 재업로드. readOnly(열람)는 건드림
  // 금지.
  //
  // ⚠️ StrictMode(dev)는 effect 를 mount→cleanup→mount 로 두 번 돈다. ref 는
  // 재마운트에도 유지되므로 `migratedRef` 가드가 단 한 번 실행을 보장한다.
  // **cleanup 에서 작업을 취소(cancel)하면 안 된다** — 1차(취소된) 마운트가
  // 번들 생성·patch 를 건너뛰고 2차 마운트는 가드에 막혀, "전환 중…"만 남고
  // 영영 전환이 안 되는 버그가 됨. 그래서 cancel 플래그 없이 patch 를 끝까지
  // 수행한다(번들 생성은 멱등이 아니지만 ref 가드로 1회만 실행되니 안전).
  useEffect(() => {
    if (readOnly) return
    if (!fileId || bundleId) return
    if (migratedRef.current) return
    migratedRef.current = true
    setMigrating(true)
    ;(async () => {
      try {
        const blob = await fetchFileBlob(fileId)
        const name = filename || 'index.html'
        const file = new File([blob], name, {
          type: blob.type || 'text/html',
        })
        const meta = await createEmbedBundle([{ file, path: name }], name)
        patch({
          bundle_id: meta.id,
          entry_path: meta.entry_path,
          filename: name,
          file_id: undefined,
        })
      } catch (err) {
        // 레거시 srcdoc 렌더는 살아 있으므로 치명적이진 않지만, 원인을 알 수
        // 있게 노출한다. 자동 재시도는 안 함(무한 재시도/토스트 폭탄 방지) —
        // 사용자가 같은 파일을 다시 올리면 수동 전환 가능.
        // eslint-disable-next-line no-console
        console.error('[HtmlEmbed] 레거시 번들 전환 실패:', err)
        toast.error(
          `새 탭 지원 전환 실패: ${err?.message || err}. 파일을 다시 올리면 재시도됩니다.`,
        )
      } finally {
        setMigrating(false)
      }
    })()
    // file_id 가 바뀌면(다른 파일로 교체) 다시 평가. patch/filename 은 의도적으로
    // 제외 — 매 patch 마다 재실행되면 안 됨.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, bundleId, readOnly])

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
    // 표시 모드 / 표지 필드 — 비면 기본값을 타도록 키 자체를 제거(§8.1).
    if (merged.display !== 'inline') delete merged.display // 기본 card 는 저장 안 함
    if (!merged.height_px) delete merged.height_px // 미설정 시 반응형 70vh
    if (!merged.title) delete merged.title
    if (!merged.description) delete merged.description
    if (!merged.cover_file_id) delete merged.cover_file_id
    // 미디어가 없으면 표시 옵션도 의미 없음 → 정리.
    if (!merged.file_id && !merged.bundle_id) {
      delete merged.display
      delete merged.height_px
      delete merged.title
      delete merged.description
      delete merged.cover_file_id
    }
    onChange(merged)
  }

  // 단일 .html 업로드 — **1-파일 번들**로 만든다(§8.1). srcdoc 이 아니라 번들
  // 서빙 URL 을 가져야 새 탭/전체화면이 단일·폴더 구분 없이 일관되게 동작하고,
  // 서빙 응답의 CSP sandbox 로 최상위 탭에서도 토큰 탈취가 막힌다. (레거시
  // file_id srcdoc 경로는 이미 저장된 보고서 하위호환용으로만 렌더에 남겨둠.)
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
      // 엔트리 = 파일명(폴더 없는 단일 파일이라 상대경로 == 이름).
      const entry = file.name
      const meta = await createEmbedBundle([{ file, path: entry }], entry)
      // 이전 번들이 있으면(다시 올리는 경우) 정리.
      if (bundleId && bundleId !== meta.id)
        deleteEmbedBundle(bundleId).catch(() => {})
      patch({
        bundle_id: meta.id,
        entry_path: meta.entry_path,
        filename: file.name,
        file_id: undefined,
      })
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
    // 단일 html 한 개만 떨군 경우는 staging 없이 바로 1-파일 번들로(§8.1) —
    // 엔트리가 자명하므로 지정 단계를 건너뛴다.
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
              {bundleId && (entryPath || '').includes('/') ? (
                <Folder className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <FileCode2 className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate flex-1">
                {bundleId
                  ? (entryPath || '').includes('/')
                    ? `${entryPath} · 폴더 번들`
                    : `${entryPath || filename} · HTML`
                  : migrating
                    ? `${filename || fileId} · 새 탭 지원으로 전환 중…`
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
          {!readOnly && (
            <HtmlEmbedDisplayControls content={content} patch={patch} />
          )}
          <HtmlEmbedView content={content} label={props.label} />
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

// ── 렌더 헬퍼 ────────────────────────────────────────────────────────────────

// 단일 파일(srcdoc) 모드의 HTML 바이트 로드. 번들 모드면 안 가져옴(src 직접 로드).
function useSingleFileHtml(fileId, bundleId) {
  const [state, setState] = useState({ html: '', loading: false, error: '' })
  useEffect(() => {
    if (bundleId || !fileId) {
      setState({ html: '', loading: false, error: '' })
      return undefined
    }
    let cancelled = false
    setState({ html: '', loading: true, error: '' })
    ;(async () => {
      try {
        const blob = await fetchFileBlob(fileId)
        const text = await blob.text()
        if (!cancelled) setState({ html: text, loading: false, error: '' })
      } catch (e) {
        if (!cancelled)
          setState({ html: '', loading: false, error: e?.message || '불러오기 실패' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fileId, bundleId])
  return state
}

// file_id → objectURL (표지 썸네일 표시용). 언마운트 시 revoke.
function useFileObjectUrl(fileId) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    if (!fileId) {
      setUrl(null)
      return undefined
    }
    let cancelled = false
    let obj = null
    ;(async () => {
      try {
        const blob = await fetchFileBlob(fileId)
        if (cancelled) return
        obj = URL.createObjectURL(blob)
        setUrl(obj)
      } catch {
        if (!cancelled) setUrl(null)
      }
    })()
    return () => {
      cancelled = true
      if (obj) URL.revokeObjectURL(obj)
    }
  }, [fileId])
  return url
}

// 격리된 iframe. 번들=src(상대 URL·호스트 무관), 단일=srcdoc. 둘 다
// sandbox="allow-scripts"(null origin) → 스크립트는 돌되 보고서엔 격리.
function EmbedIframe({ bundleId, entryPath, html, title, className, style }) {
  if (bundleId) {
    return (
      <iframe
        title={title || 'HTML embed'}
        src={embedBundleUrl(bundleId, entryPath || 'index.html')}
        sandbox="allow-scripts"
        className={className}
        style={style}
      />
    )
  }
  return (
    <iframe
      title={title || 'HTML embed'}
      srcDoc={html}
      sandbox="allow-scripts"
      className={className}
      style={style}
    />
  )
}

// 전체화면 오버레이 — 앱 레벨 CSS(position:fixed). 브라우저 Fullscreen API 가
// 아니라 sandbox 제약·권한 문제 없음. iframe 격리(null origin)는 그대로 유지.
function FullscreenEmbed({ title, onClose, children }) {
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

/**
 * 임베드 표시(§8.1). 위젯을 "관문(gateway)"으로 — display="card"(기본)면
 * 표지 + 열기 버튼만 보이고, "inline"이면 박스 안 iframe 을 바로 펼친다.
 * 전체화면·새 탭 버튼은 모드와 무관하게 항상 노출.
 */
function HtmlEmbedView({ content, label }) {
  const fileId = content?.file_id ?? null
  const bundleId = content?.bundle_id ?? null
  const entryPath = content?.entry_path ?? ''
  const filename = content?.filename ?? ''
  const display = content?.display === 'inline' ? 'inline' : 'card'
  // 미설정 시 반응형 70vh, 지정 시 고정 px(§8.1 — 임의 HTML 은 자동맞춤 불가).
  const height = content?.height_px ? `${content.height_px}px` : '70vh'
  const title =
    content?.title || content?.caption || filename || label || 'HTML'
  const description = content?.description || ''
  const coverUrl = useFileObjectUrl(content?.cover_file_id || null)
  const { html, loading, error } = useSingleFileHtml(fileId, bundleId)
  const [fullscreen, setFullscreen] = useState(false)
  // 새 탭은 자기 URL 이 있는 번들만(단일 srcdoc 은 URL 없음).
  const newTabUrl = bundleId
    ? embedBundleUrl(bundleId, entryPath || 'index.html')
    : null

  const toolbar = (
    <div className="flex items-center gap-1">
      <Button variant="outline" size="sm" onClick={() => setFullscreen(true)}>
        <Maximize2 className="mr-1 h-3.5 w-3.5" />
        전체화면
      </Button>
      {newTabUrl && (
        <Button variant="outline" size="sm" asChild>
          <a href={newTabUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="mr-1 h-3.5 w-3.5" />새 탭
          </a>
        </Button>
      )}
    </div>
  )

  const fullscreenNode = fullscreen ? (
    <FullscreenEmbed title={title} onClose={() => setFullscreen(false)}>
      <EmbedIframe
        bundleId={bundleId}
        entryPath={entryPath}
        html={html}
        title={title}
        className="h-full w-full rounded-md border-0 bg-white"
      />
    </FullscreenEmbed>
  ) : null

  // 단일 파일 로딩/에러는 인라인 본문 자리에 표시.
  if (display === 'inline') {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-end">{toolbar}</div>
        {loading ? (
          <div
            className="flex items-center justify-center rounded-md border bg-background text-xs text-muted-foreground"
            style={{ height }}
          >
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            HTML 불러오는 중…
          </div>
        ) : error ? (
          <div
            className="flex items-center justify-center rounded-md border bg-background text-xs text-destructive"
            style={{ height }}
          >
            {error}
          </div>
        ) : (
          <EmbedIframe
            bundleId={bundleId}
            entryPath={entryPath}
            html={html}
            title={title}
            className="w-full rounded-md border bg-background"
            style={{ height }} // 임의 단위(vh/px) 허용
          />
        )}
        {fullscreenNode}
      </div>
    )
  }

  // card 모드 — 표지 + 열기 버튼.
  return (
    <div className="rounded-md border bg-muted/20">
      <div className="flex items-stretch gap-3 p-3">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt=""
            className="h-16 w-24 shrink-0 rounded border object-cover"
          />
        ) : (
          <div className="flex h-16 w-24 shrink-0 items-center justify-center rounded border bg-background text-muted-foreground">
            {bundleId ? (
              <Folder className="h-6 w-6" />
            ) : (
              <FileCode2 className="h-6 w-6" />
            )}
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="truncate text-sm font-medium">{title}</div>
          {description && (
            <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {description}
            </div>
          )}
          <div className="mt-auto pt-2">{toolbar}</div>
        </div>
      </div>
      {fullscreenNode}
    </div>
  )
}

/**
 * 편집 중 표시 옵션 컨트롤(§8.1) — 표시 모드 / 표지 제목·설명·이미지 / inline 높이.
 * 모두 Optional, 비우면 기본값(card · 70vh)을 탄다.
 */
function HtmlEmbedDisplayControls({ content, patch }) {
  const display = content?.display === 'inline' ? 'inline' : 'card'
  const [coverUploading, setCoverUploading] = useState(false)
  const coverInputRef = useRef(null)

  async function handleCover(fileList) {
    const file = Array.from(fileList || [])[0]
    if (!file) return
    setCoverUploading(true)
    try {
      const meta = await uploadFile(file)
      patch({ cover_file_id: meta.id })
    } catch (err) {
      toast.error(err.message || '표지 업로드 실패')
    } finally {
      setCoverUploading(false)
      if (coverInputRef.current) coverInputRef.current.value = ''
    }
  }

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
              min={60}
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

      {display === 'card' && (
        <div className="space-y-2">
          <input
            value={content?.title || ''}
            placeholder="표지 제목 (비우면 캡션·파일명)"
            onChange={(e) => patch({ title: e.target.value })}
            className="w-full rounded border bg-background px-1.5 py-1 text-[11px]"
          />
          <textarea
            value={content?.description || ''}
            placeholder="표지 설명 (선택)"
            rows={2}
            onChange={(e) => patch({ description: e.target.value })}
            className="w-full resize-none rounded border bg-background px-1.5 py-1 text-[11px]"
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={coverUploading}
              onClick={() => coverInputRef.current?.click()}
            >
              {coverUploading ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ImagePlus className="mr-1 h-3.5 w-3.5" />
              )}
              표지 이미지
            </Button>
            {content?.cover_file_id && (
              <button
                type="button"
                onClick={() => patch({ cover_file_id: undefined })}
                className="text-muted-foreground hover:text-destructive"
              >
                표지 제거
              </button>
            )}
            <input
              ref={coverInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => handleCover(e.target.files)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
