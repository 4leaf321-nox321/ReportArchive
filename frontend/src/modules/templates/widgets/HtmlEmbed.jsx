import { useEffect, useRef, useState } from 'react'
import { FileCode2, Loader2, Upload, X } from 'lucide-react'
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

/**
 * HTML embed widget — author uploads an `.html` file and the widget
 * renders its contents in an isolated sandboxed iframe. The bytes are
 * fetched as text and pushed in via `srcdoc`, with `sandbox="allow-
 * scripts"` so author scripts execute but can't reach the parent's
 * cookies / DOM / storage (the iframe lives in a null origin).
 *
 * The widget pattern mirrors `attachment`: one file_id on the report,
 * no AI generation path (file_id can't be invented). It's intentionally
 * minimal — no header overrides, no resource whitelisting — because
 * sandbox isolates the blast radius, and the author already controls
 * what they upload.
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
        업로드한 HTML 파일은 sandbox 처리된 iframe 안에서 렌더됩니다 —
        외부 스크립트는 실행되지만 보고서 본문의 쿠키 / 로컬 스토리지에는
        접근할 수 없습니다.
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
        HTML 파일을 업로드하면 여기에 표시됩니다.
      </div>
    </div>
  )
}

export function HtmlEmbedEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  const fileId = content?.file_id ?? null
  const filename = content?.filename ?? ''
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef(null)

  function patch(next) {
    const merged = { ...(content ?? {}), ...next }
    // Strip empties so saved content stays minimal.
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (!merged.filename) delete merged.filename
    if (!merged.file_id) {
      delete merged.file_id
      // filename is meaningless without a file_id.
      delete merged.filename
    }
    onChange(merged)
  }

  async function handleFiles(fileList) {
    const incoming = Array.from(fileList || [])
    if (incoming.length === 0) return
    const file = incoming[0]
    // Best-effort extension check. Server doesn't enforce this; we just
    // warn the user so a misclicked `.pdf` doesn't quietly become an
    // unrenderable embed.
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
      patch({ file_id: meta.id, filename: meta.filename })
    } catch (err) {
      toast.error(err.message || '업로드 실패')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function clearFile() {
    if (!window.confirm('업로드된 HTML 을 제거할까요?')) return
    patch({ file_id: undefined, filename: undefined })
  }

  function onDrop(e) {
    e.preventDefault()
    if (readOnly) return
    handleFiles(e.dataTransfer.files)
  }

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

      {fileId ? (
        <>
          {!readOnly && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <FileCode2 className="h-3.5 w-3.5" />
              <span className="truncate flex-1">{filename || fileId}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-destructive"
                onClick={clearFile}
                title="HTML 제거"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          )}
          <HtmlEmbedFrame fileId={fileId} title={filename || props.label} />
        </>
      ) : (
        !readOnly && (
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            className="border-2 border-dashed rounded-md p-6 text-center cursor-pointer hover:bg-muted/30 transition-colors"
          >
            {uploading ? (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-xs">업로드 중…</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <Upload className="h-5 w-5" />
                <span className="text-xs">
                  .html 파일을 클릭하거나 드래그해 업로드
                </span>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".html,.htm,text/html"
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </div>
        )
      )}
    </div>
  )
}

/**
 * Fetches the file's bytes via the auth'd files API, decodes as UTF-8,
 * and inlines into an iframe via `srcdoc`. `sandbox="allow-scripts"`
 * (without `allow-same-origin`) gives author HTML the ability to run
 * scripts while denying it any handle on the report's storage / cookies
 * / parent DOM. Re-fetches whenever the file_id changes; cleans up on
 * unmount via the cancel flag.
 */
function HtmlEmbedFrame({ fileId, title }) {
  const [html, setHtml] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!fileId) {
      setHtml('')
      return
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
  }, [fileId])

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
      className="flex-1 w-full min-h-[12rem] rounded-md border bg-background"
    />
  )
}
