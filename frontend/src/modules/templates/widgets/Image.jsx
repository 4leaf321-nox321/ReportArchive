import { useRef, useState } from 'react'
import { ChevronDown, ChevronUp, ImageIcon, Loader2, Upload, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { AuthedImage } from '@/shared/components/AuthedImage'
import { uploadFile } from '@/shared/api/files'
import { toast } from 'sonner'
import { CaptionInput, LabelField, PreviewLabel } from './_shared'

export function ImagePropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="증거 자료"
      />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">최대 장수</Label>
          <Input
            type="number"
            min={1}
            max={50}
            value={props.max_count ?? 1}
            onChange={(e) => onChange({ ...props, max_count: Number(e.target.value) })}
            className="mt-1 h-9"
          />
          <p className="mt-0.5 text-[10px] text-muted-foreground">1=단일, 2+=갤러리</p>
        </div>
        <div>
          <Label className="text-xs">화면비 (선택)</Label>
          <Input
            value={props.aspect_ratio ?? ''}
            onChange={(e) =>
              onChange({
                ...props,
                aspect_ratio: e.target.value || undefined,
              })
            }
            placeholder="16:9"
            className="mt-1 h-9"
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={!!props.caption_required}
          onChange={(e) => onChange({ ...props, caption_required: e.target.checked })}
        />
        캡션 필수
      </label>
    </div>
  )
}

export function ImageEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  const files = content?.files ?? []
  const max = props.max_count ?? 1
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const fileInputRef = useRef(null)

  // Always emit both fields so the saved content shape stays stable
  // regardless of which one the user touched first.
  function patchContent(patch) {
    const next = { caption, files, ...patch }
    if (!next.caption) delete next.caption
    onChange(next)
  }
  function update(idx, patch) {
    patchContent({
      files: files.map((f, i) => (i === idx ? { ...f, ...patch } : f)),
    })
  }
  function remove(idx) {
    patchContent({ files: files.filter((_, i) => i !== idx) })
  }
  function move(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= files.length) return
    const next = [...files]
    const [item] = next.splice(idx, 1)
    next.splice(newIdx, 0, item)
    patchContent({ files: next })
  }

  async function handleFiles(fileList) {
    const incoming = Array.from(fileList || [])
    const slots = max - files.length
    if (slots <= 0) {
      toast.error(`최대 ${max}장까지 업로드 가능합니다.`)
      return
    }
    const accepted = incoming.slice(0, slots).filter((f) => {
      if (!f.type.startsWith('image/')) {
        toast.error(`이미지 파일만 가능: ${f.name}`)
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
        uploaded.push({ file_id: meta.id, alt: file.name })
      }
      patchContent({ files: [...files, ...uploaded] })
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
  const aspectClass = aspectRatioToClass(props.aspect_ratio)

  if (readOnly) {
    if (!caption && files.length === 0) return null
    return (
      <div className="space-y-2">
        <CaptionInput value={caption} readOnly />
        {files.length > 0 && (
          <div className={`grid gap-2 ${max > 1 ? 'grid-cols-3' : 'grid-cols-1'}`}>
            {files.map((file, idx) => (
              <figure key={idx} className="space-y-1">
                <div className={`relative ${aspectClass} bg-muted/30 rounded-md overflow-hidden`}>
                  <AuthedImage
                    fileId={file.file_id}
                    alt={file.alt}
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                </div>
                {file.caption && (
                  <figcaption className="text-xs text-muted-foreground text-center">
                    {file.caption}
                  </figcaption>
                )}
              </figure>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <CaptionInput
        value={caption}
        onChange={(v) => patchContent({ caption: v })}
        placeholder={props.label}
      />
      {files.length > 0 && (
        <div className={`grid gap-2 ${max > 1 ? 'grid-cols-3' : 'grid-cols-1'}`}>
          {files.map((file, idx) => (
            <div
              key={idx}
              className="rounded-md border bg-muted/10 overflow-hidden flex flex-col"
            >
              <div className={`relative ${aspectClass} bg-muted/30`}>
                <AuthedImage
                  fileId={file.file_id}
                  alt={file.alt}
                  className="absolute inset-0 w-full h-full object-cover"
                />
                <div className="absolute top-1 right-1 flex items-center gap-0.5 bg-background/80 rounded">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={idx === 0}
                    onClick={(e) => {
                      e.stopPropagation()
                      move(idx, -1)
                    }}
                  >
                    <ChevronUp className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={idx === files.length - 1}
                    onClick={(e) => {
                      e.stopPropagation()
                      move(idx, 1)
                    }}
                  >
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-destructive"
                    onClick={(e) => {
                      e.stopPropagation()
                      remove(idx)
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              <div className="p-1.5 space-y-1">
                <Input
                  value={file.caption ?? ''}
                  onChange={(e) =>
                    update(idx, { caption: e.target.value || undefined })
                  }
                  placeholder={
                    props.caption_required ? '캡션 (필수)' : '캡션 (선택)'
                  }
                  className="h-7 text-xs"
                />
                <Input
                  value={file.alt ?? ''}
                  onChange={(e) =>
                    update(idx, { alt: e.target.value || undefined })
                  }
                  placeholder="alt 텍스트"
                  className="h-7 text-xs"
                />
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
          className="border-2 border-dashed rounded-md p-6 text-center cursor-pointer hover:bg-muted/30 transition-colors"
        >
          {uploading ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-xs">업로드 중… {Math.round(progress * 100)}%</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Upload className="h-5 w-5" />
              <span className="text-xs">
                이미지 끌어다 놓거나 클릭해 업로드
                <span className="text-[10px] block mt-0.5">
                  남은 슬롯 {max - files.length}/{max}
                </span>
              </span>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple={max > 1}
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
      )}
    </div>
  )
}

function aspectRatioToClass(ratio) {
  if (!ratio) return 'aspect-video'
  // Tailwind aspect-* presets we ship with by default
  const map = {
    '16:9': 'aspect-video',
    '4:3': 'aspect-[4/3]',
    '1:1': 'aspect-square',
    '3:2': 'aspect-[3/2]',
    '2:1': 'aspect-[2/1]',
  }
  return map[ratio] || 'aspect-video'
}

export function ImagePreview({ props }) {
  const count = Math.min(props.max_count ?? 1, 3)
  const isGallery = (props.max_count ?? 1) > 1
  return (
    <div className="space-y-2">
      <PreviewLabel
        hint={isGallery ? `최대 ${props.max_count}장` : '단일 이미지'}
      >
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className={`grid gap-2 ${isGallery ? 'grid-cols-3' : 'grid-cols-1'}`}>
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center text-muted-foreground"
          >
            <ImageIcon className="h-6 w-6" />
          </div>
        ))}
      </div>
    </div>
  )
}
