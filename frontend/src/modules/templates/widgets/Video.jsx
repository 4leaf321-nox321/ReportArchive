/**
 * Video widget — playable video files (mp4 / webm / mov / etc.).
 *
 * Same file-id storage model as image / attachment / html_embed: each
 * upload goes through /api/files, the report stores the returned
 * `file_id`, and the widget fetches the bytes back through the auth'd
 * files endpoint at render time. The fetched blob feeds a native
 * <video controls> element via a blob: URL — that keeps the auth
 * header in the loop (the <video src> attribute can't carry it) at the
 * cost of buffering the whole file in memory before playback starts.
 *
 * AI / JSON imports never create this widget (no file_id to invent),
 * so it joins the existing image / attachment / cad_3d / html_embed
 * "AI 가 만들지 마세요" group in the prompt catalog.
 */
import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Film,
  Loader2,
  Upload,
  X,
} from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { fetchFileBlob, uploadFile } from '@/shared/api/files'
import { toast } from 'sonner'
import {
  CaptionInput,
  LabelField,
  PreviewLabel,
  captionSkipProps,
} from './_shared'

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.ogg', '.m4v', '.mkv']

// --------------------------------------------------------------------------- //
// Props panel                                                                   //
// --------------------------------------------------------------------------- //

export function VideoPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="동영상"
      />
      <div>
        <Label className="text-xs">최대 개수</Label>
        <Input
          type="number"
          min={1}
          max={10}
          value={props.max_count ?? 1}
          onChange={(e) => onChange({ ...props, max_count: Number(e.target.value) })}
          className="mt-1 h-9"
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <label className="flex items-center gap-1 cursor-pointer text-xs">
          <input
            type="checkbox"
            checked={!!props.autoplay}
            onChange={(e) => onChange({ ...props, autoplay: e.target.checked })}
          />
          <span>자동 재생</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer text-xs">
          <input
            type="checkbox"
            checked={!!props.loop}
            onChange={(e) => onChange({ ...props, loop: e.target.checked })}
          />
          <span>반복</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer text-xs">
          <input
            type="checkbox"
            checked={props.muted !== false}
            onChange={(e) => onChange({ ...props, muted: e.target.checked })}
          />
          <span>음소거</span>
        </label>
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        브라우저는 보통 음소거 상태가 아니면 자동 재생을 막습니다 —
        자동 재생이 필요하면 음소거를 함께 켜세요.
      </p>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview                                                                       //
// --------------------------------------------------------------------------- //

export function VideoPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel hint="동영상">
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center text-muted-foreground">
        <Film className="h-6 w-6" />
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //

export function VideoEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  const files = Array.isArray(content?.files) ? content.files : []
  const max = props.max_count ?? 1
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const fileInputRef = useRef(null)

  const playback = {
    autoplay: !!props.autoplay,
    loop: !!props.loop,
    // Default muted=true so autoplay actually works in modern browsers.
    muted: props.muted !== false,
  }

  function patch(next) {
    const merged = { ...(content ?? {}), caption, files, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    onChange(merged)
  }
  function remove(idx) {
    if (!window.confirm('이 동영상을 제거할까요?')) return
    patch({ files: files.filter((_, i) => i !== idx) })
  }
  function move(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= files.length) return
    const next = [...files]
    const [item] = next.splice(idx, 1)
    next.splice(newIdx, 0, item)
    patch({ files: next })
  }

  async function handleFiles(fileList) {
    const incoming = Array.from(fileList || [])
    if (incoming.length === 0) return
    const slots = max - files.length
    if (slots <= 0) {
      toast.error(`최대 ${max}개까지 업로드 가능합니다.`)
      return
    }
    const accepted = incoming.slice(0, slots).filter((f) => {
      const lower = f.name.toLowerCase()
      const okExt = VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))
      const okMime = (f.type || '').startsWith('video/')
      if (!okExt && !okMime) {
        toast.error(`동영상 파일이 아닙니다: ${f.name}`)
        return false
      }
      return true
    })
    if (accepted.length === 0) return

    setUploading(true)
    setProgress(0)
    const uploaded = []
    try {
      for (let i = 0; i < accepted.length; i += 1) {
        const file = accepted[i]
        const meta = await uploadFile(file, {
          onProgress: (p) => setProgress((i + p) / accepted.length),
        })
        uploaded.push({
          file_id: meta.id,
          filename: meta.filename,
          size: meta.size,
          mime_type: meta.mime_type,
        })
      }
      patch({ files: [...files, ...uploaded] })
    } catch (err) {
      toast.error(err.message || '업로드 실패')
    } finally {
      setUploading(false)
      setProgress(0)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function onDrop(e) {
    e.preventDefault()
    if (readOnly) return
    handleFiles(e.dataTransfer.files)
  }

  const canAdd = files.length < max

  if (readOnly) {
    if (!caption && files.length === 0) return null
    return (
      <div className="space-y-2 flex flex-col h-full min-h-0">
        <CaptionInput
          value={caption}
          readOnly
          placeholder={props.label}
          skipAutofill={content?.caption_skip_autofill}
        />
        {files.length > 0 && (
          <div className="flex-1 min-h-0 grid gap-3 grid-cols-1">
            {files.map((file, idx) => (
              <VideoPlayer key={idx} file={file} playback={playback} />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2 flex flex-col h-full min-h-0">
      <CaptionInput
        value={caption}
        onChange={(v) => patch({ caption: v })}
        placeholder={props.label}
        {...captionSkipProps({ content, patch })}
      />

      {files.length > 0 && (
        <div className="flex-1 min-h-0 grid gap-3 grid-cols-1 overflow-y-auto">
          {files.map((file, idx) => (
            <div key={idx} className="space-y-1">
              <VideoPlayer file={file} playback={playback} />
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Film className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1 truncate">
                  {file.filename || file.file_id}
                </span>
                {file.size != null && (
                  <span className="text-[10px]">{formatSize(file.size)}</span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={idx === 0}
                  onClick={() => move(idx, -1)}
                >
                  <ChevronUp className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={idx === files.length - 1}
                  onClick={() => move(idx, 1)}
                >
                  <ChevronDown className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-destructive"
                  onClick={() => remove(idx)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {canAdd && (
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          className="border-2 border-dashed rounded-md p-4 text-center cursor-pointer hover:bg-muted/30 transition-colors shrink-0"
        >
          {uploading ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-xs">
                업로드 중… {Math.round(progress * 100)}%
              </span>
              <span className="text-[10px]">
                큰 파일은 시간이 좀 걸립니다
              </span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Upload className="h-5 w-5" />
              <span className="text-xs">
                {VIDEO_EXTENSIONS.join(' / ')} 파일을 클릭하거나 드래그해 업로드
              </span>
              <span className="text-[10px]">
                {files.length} / {max} 개
              </span>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            multiple={max > 1}
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Fetches the file bytes via the auth'd files API, wraps them in a
 * blob: URL, and feeds the URL into a native <video controls>. The
 * blob URL is revoked on unmount / src change so we don't pile up
 * object URLs across navigations.
 *
 * Limitation: the whole video is downloaded before playback starts (we
 * can't add the Authorization header to a streaming <video src>). For
 * the report-archive use case (short demo clips, results videos) that's
 * usually fine — if multi-GB streaming becomes a need, a signed-URL or
 * token-in-query API would let <video> stream natively.
 */
function VideoPlayer({ file, playback }) {
  const [blobUrl, setBlobUrl] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!file?.file_id) {
      setBlobUrl('')
      return undefined
    }
    let cancelled = false
    let currentUrl = ''
    setLoading(true)
    setError('')
    ;(async () => {
      try {
        const blob = await fetchFileBlob(file.file_id)
        if (cancelled) return
        currentUrl = URL.createObjectURL(blob)
        setBlobUrl(currentUrl)
      } catch (e) {
        if (!cancelled) setError(e?.message || '동영상 불러오기 실패')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      if (currentUrl) URL.revokeObjectURL(currentUrl)
    }
  }, [file?.file_id])

  if (loading) {
    return (
      <div className="aspect-video bg-muted/40 rounded-md flex items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        동영상 불러오는 중…
      </div>
    )
  }
  if (error) {
    return (
      <div className="aspect-video bg-muted/40 rounded-md flex items-center justify-center text-xs text-destructive">
        {error}
      </div>
    )
  }
  return (
    <video
      src={blobUrl}
      controls
      autoPlay={!!playback?.autoplay}
      loop={!!playback?.loop}
      // Forced muted when autoplay is on so the browser actually
      // honors it — otherwise modern browsers block sound-on autoplay.
      muted={!!playback?.muted || !!playback?.autoplay}
      playsInline
      className="w-full max-h-full rounded-md bg-black"
      // `preload="metadata"` keeps the network footprint small until
      // the user actually presses play (we still download the full blob
      // up front, but the metadata-only hint helps the browser show a
      // poster frame without decoding the whole stream right away).
      preload="metadata"
    />
  )
}

function formatSize(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`
}
