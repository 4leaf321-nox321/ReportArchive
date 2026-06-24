import { useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Download, Loader2, Paperclip, Upload, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { downloadFile, uploadFile } from '@/shared/api/files'
import { toast } from 'sonner'
import {
  CaptionInput,
  EditorOptionBar,
  EditorOptionNumber,
  LabelField,
  PreviewLabel,
  captionPositionOf,
  captionSkipProps,
  effectiveNumber,
  pruneOverrideKeys,
} from './_shared'

export function AttachmentPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="첨부 파일"
      />
      <div>
        <Label className="text-xs">최대 개수</Label>
        <Input
          type="number"
          min={1}
          max={50}
          value={props.max_count ?? 5}
          onChange={(e) => onChange({ ...props, max_count: Number(e.target.value) })}
          className="mt-1 h-9"
        />
      </div>
      <div>
        <Label className="text-xs">허용 확장자 (쉼표 구분)</Label>
        <Input
          value={(props.allowed_extensions ?? []).join(', ')}
          onChange={(e) => {
            const exts = e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
              .map((s) => (s.startsWith('.') ? s : `.${s}`))
            onChange({
              ...props,
              allowed_extensions: exts.length === 0 ? undefined : exts,
            })
          }}
          placeholder=".pdf, .xlsx, .docx"
          className="mt-1 h-9"
        />
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          비우면 모든 확장자 허용. 점(.) 누락 시 자동 추가.
        </p>
      </div>
    </div>
  )
}

export function AttachmentEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  const files = content?.files ?? []
  // Per-report soft cap — content wins, then template's max_count, then 5.
  // The hard validation cap stays at props.max_count via the content
  // schema's maxItems; this just narrows the UI quota further so the
  // writer can declare "this report wants only 2 files" without
  // editing the template.
  const max = Math.min(
    effectiveNumber(content, props, 'max_count', 5),
    props.max_count ?? 50,
  )
  const allowed = props.allowed_extensions ?? null
  const capPos = captionPositionOf(content)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const fileInputRef = useRef(null)

  function patch(next) {
    const merged = { ...(content ?? {}), caption, files, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    pruneOverrideKeys(merged, props, { max_count: 5 })
    onChange(merged)
  }
  function remove(idx) {
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
    const slots = max - files.length
    if (slots <= 0) {
      toast.error(`최대 ${max}개까지 업로드 가능합니다.`)
      return
    }
    const accepted = incoming.slice(0, slots).filter((f) => {
      if (!allowed) return true
      const lower = f.name.toLowerCase()
      const ok = allowed.some((ext) => lower.endsWith(ext.toLowerCase()))
      if (!ok) {
        toast.error(`허용되지 않는 확장자: ${f.name}`)
      }
      return ok
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
        uploaded.push({ file_id: meta.id, filename: meta.filename, size: meta.size })
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
    handleFiles(e.dataTransfer.files)
  }

  const canAdd = files.length < max

  if (readOnly) {
    if (!caption && files.length === 0) return null
    return (
      <div className="space-y-2">
        {capPos !== 'below' && (
          <CaptionInput
            value={caption}
            readOnly
            placeholder={props.label}
            skipAutofill={content?.caption_skip_autofill}
            color={content?.caption_color}
            html={content?.caption_html}
          />
        )}
        {files.length > 0 && (
          <ul className="space-y-1.5">
            {files.map((file, idx) => (
              <li
                key={idx}
                className="rounded-md border bg-muted/10 p-2 flex items-center gap-2"
              >
                <Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{file.filename || file.file_id}</div>
                  {file.size != null && (
                    <div className="text-[10px] text-muted-foreground">
                      {formatSize(file.size)}
                    </div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  // HTML export 가 이 마커를 읽어 죽은 JS 버튼을 실제 동작하는
                  // <a download href="data:..."> 로 교체한다(inlineAttachments).
                  data-export-attachment-file-id={file.file_id}
                  data-export-attachment-name={file.filename || file.file_id}
                  onClick={() => downloadFile(file.file_id, file.filename)}
                  title="다운로드"
                >
                  <Download className="h-3 w-3" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {capPos === 'below' && (
          <CaptionInput
            value={caption}
            readOnly
            placeholder={props.label}
            skipAutofill={content?.caption_skip_autofill}
            color={content?.caption_color}
            html={content?.caption_html}
          />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {capPos !== 'below' && (
        <CaptionInput
          value={caption}
          onChange={(v) => patch({ caption: v })}
          placeholder={props.label}
          {...captionSkipProps({ content, patch })}
        />
      )}
      <EditorOptionBar>
        <EditorOptionNumber
          label="최대 개수"
          value={max}
          min={1}
          max={props.max_count ?? 50}
          onChange={(v) => patch({ max_count: v })}
          suffix={`(현재 ${files.length}개)`}
          width="w-14"
          hint="이 보고서에서 허용할 첨부 개수를 줄일 수 있습니다 (템플릿보다 늘릴 수는 없음)."
        />
      </EditorOptionBar>
      {files.length > 0 && (
        <ul className="space-y-1.5">
          {files.map((file, idx) => (
            <li
              key={idx}
              className="rounded-md border bg-muted/10 p-2 flex items-center gap-2"
            >
              <Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{file.filename || file.file_id}</div>
                {file.size != null && (
                  <div className="text-[10px] text-muted-foreground">
                    {formatSize(file.size)}
                  </div>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => downloadFile(file.file_id, file.filename)}
                title="다운로드"
              >
                <Download className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={idx === 0}
                onClick={() => move(idx, -1)}
              >
                <ChevronUp className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={idx === files.length - 1}
                onClick={() => move(idx, 1)}
              >
                <ChevronDown className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive"
                onClick={() => remove(idx)}
              >
                <X className="h-3 w-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {canAdd && (
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          className="border-2 border-dashed rounded-md p-4 text-center cursor-pointer hover:bg-muted/30 transition-colors"
        >
          {uploading ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-xs">업로드 중… {Math.round(progress * 100)}%</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Upload className="h-5 w-5" />
              <div className="text-xs">
                파일 끌어다 놓거나 클릭해 업로드
                <div className="text-[10px] mt-0.5">
                  남은 슬롯 {max - files.length}/{max}
                  {allowed && allowed.length > 0 && (
                    <span> · {allowed.join(', ')}</span>
                  )}
                </div>
              </div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple={max > 1}
            className="hidden"
            accept={allowed?.join(',') || undefined}
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
      )}
      {capPos === 'below' && (
        <CaptionInput
          value={caption}
          onChange={(v) => patch({ caption: v })}
          placeholder={props.label}
          {...captionSkipProps({ content, patch })}
        />
      )}
    </div>
  )
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function AttachmentPreview({ props }) {
  const exts = props.allowed_extensions ?? []
  return (
    <div className="space-y-2">
      <PreviewLabel hint={`최대 ${props.max_count ?? 5}개`}>
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="rounded-md border border-dashed p-4 bg-muted/20 flex items-center gap-3 text-muted-foreground">
        <Paperclip className="h-5 w-5" />
        <div className="text-xs">
          <div>파일을 끌어다 놓거나 클릭해 업로드</div>
          {exts.length > 0 && (
            <div className="text-[10px] mt-0.5">허용: {exts.join(', ')}</div>
          )}
        </div>
      </div>
    </div>
  )
}
